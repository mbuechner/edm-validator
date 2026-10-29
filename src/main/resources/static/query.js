/* Browser queries read the current shared document; no validation result is required. */
(() => {
    'use strict';
    const byId = id => document.getElementById(id);
    if (!byId('queryWorkspace') || !window.RdfSource) return;
    const defaults = {
        xpath: `/rdf:RDF/edm:Place[
  @rdf:about = /rdf:RDF/edm:ProvidedCHO/edm:currentLocation/@rdf:resource
]/skos:prefLabel/text()`,
        sparql: `PREFIX edm:  <http://www.europeana.eu/schemas/edm/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

SELECT ?locationLabel
WHERE {
  ?object edm:currentLocation ?place .
  ?place skos:prefLabel ?locationLabel .
}`
    };
    let modulePromise = null;
    let sparqlRevision = 0;
    let running = false;
    let xmlCache = null;

    const rdfLibrary = () => typeof window.$rdf?.graph === 'function' && typeof window.$rdf.parse === 'function'
        && typeof window.$rdf.SPARQLToQuery === 'function' ? window.$rdf : null;

    function loadRdflib() {
        const loaded = rdfLibrary();
        if (loaded) return Promise.resolve(loaded);
        if (!modulePromise) modulePromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = './vendor/rdflib-2.4.0.min.js';
            script.async = true;
            const timeout = window.setTimeout(fail, 30000);
            function finish() {
                window.clearTimeout(timeout);
                script.onload = null;
                script.onerror = null;
            }
            function fail() {
                finish();
                script.remove();
                reject(new Error('Die SPARQL-Bibliothek konnte nicht geladen werden. Bitte erneut versuchen.'));
            }
            script.onload = () => {
                const library = rdfLibrary();
                if (!library) return fail();
                finish();
                resolve(library);
            };
            script.onerror = fail;
            document.head.append(script);
        }).catch(error => { modulePromise = null; throw error; });
        return modulePromise;
    }

    function parseXml(text) {
        const xml = new DOMParser().parseFromString(text, 'application/xml');
        const error = xml.querySelector('parsererror');
        if (error) throw new Error('Das XML ist nicht wohlgeformt: ' + error.textContent);
        return xml;
    }

    /** Query text changes do not require parsing the same source document again. */
    function parsedXml(source) {
        if (!xmlCache || xmlCache.text !== source.rdfXml) {
            xmlCache = { text: source.rdfXml, document: parseXml(source.rdfXml), resolver: null };
        }
        return xmlCache;
    }

    function namespaces(xml) {
        const map = Object.assign(Object.create(null), { rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' });
        for (const node of xml.getElementsByTagName('*')) {
            for (const attribute of node.attributes) {
                if (attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/' && attribute.prefix === 'xmlns') {
                    map[attribute.localName] = attribute.value;
                }
            }
        }
        return prefix => map[prefix] || null;
    }

    function serialize(node) {
        return [Node.ATTRIBUTE_NODE, Node.TEXT_NODE, Node.CDATA_SECTION_NODE].includes(node.nodeType)
            ? node.nodeValue : new XMLSerializer().serializeToString(node);
    }

    function showRows(target, rows) {
        if (!rows.length) { target.textContent = 'Die Abfrage lieferte keine Treffer.'; return; }
        const heading = document.createElement('strong');
        heading.textContent = rows.length + ' Treffer';
        const list = document.createElement('ul');
        list.className = 'mb-0 mt-2';
        for (const value of rows) {
            const item = document.createElement('li');
            if (window.CodeView && (/^\s*</.test(value) || /[\r\n]/.test(value))) {
                const pre = document.createElement('pre');
                pre.className = 'source-code border rounded p-2 mb-2 overflow-auto';
                CodeView.render(pre, value, /^\s*</.test(value) ? 'markup' : 'none');
                item.append(pre);
            } else {
                const code = document.createElement('code');
                code.className = 'source-code text-break';
                code.textContent = value;
                item.append(code);
            }
            list.append(item);
        }
        target.replaceChildren(heading, list);
    }

    function runXPath() {
        const target = byId('xpathQueryResult');
        const source = RdfSource.get();
        const query = byId('xpathQueryInput').value.trim();
        if (!source.rdfXml.trim() || !query) {
            target.textContent = 'Bitte RDF/XML und eine XPath-Abfrage eingeben.';
            return;
        }
        try {
            const parsed = parsedXml(source);
            const xml = parsed.document;
            parsed.resolver ||= namespaces(xml);
            const result = xml.evaluate(query, xml, parsed.resolver, XPathResult.ANY_TYPE, null);
            const rows = [];
            if (result.resultType === XPathResult.STRING_TYPE) rows.push(result.stringValue);
            else if (result.resultType === XPathResult.NUMBER_TYPE) rows.push(String(result.numberValue));
            else if (result.resultType === XPathResult.BOOLEAN_TYPE) rows.push(String(result.booleanValue));
            else {
                let node;
                while ((node = result.iterateNext())) rows.push(serialize(node));
            }
            showRows(target, rows);
        } catch (error) { target.textContent = 'XPath-Fehler: ' + error.message; }
    }

    function showBindings(target, query, rows) {
        const columns = (query.vars || []).map(variable => variable.toNT ? variable.toNT() : '?' + variable.value);
        if (!columns.length) { showRows(target, rows.map(row => JSON.stringify(row))); return; }
        if (!rows.length) { showRows(target, []); return; }
        const heading = document.createElement('strong');
        heading.textContent = rows.length + ' Treffer';
        const wrapper = document.createElement('div');
        wrapper.className = 'table-responsive mt-2';
        const table = document.createElement('table');
        table.className = 'table table-sm table-striped align-top mb-0';
        const head = table.createTHead().insertRow();
        for (const column of columns) {
            const cell = document.createElement('th');
            cell.scope = 'col';
            cell.textContent = column;
            head.append(cell);
        }
        const body = table.createTBody();
        for (const binding of rows) {
            const row = body.insertRow();
            for (const column of columns) {
                const value = binding[column];
                const cell = row.insertCell();
                cell.className = 'text-break';
                cell.textContent = value ? (value.toNT ? value.toNT() : value.value || String(value)) : '';
            }
        }
        wrapper.append(table);
        target.replaceChildren(heading, wrapper);
    }

    async function runSparql() {
        if (running) return;
        const source = RdfSource.get();
        const queryText = byId('sparqlQueryInput').value.trim();
        const target = byId('sparqlQueryResult');
        if (!source.rdfXml.trim() || !queryText) {
            target.textContent = 'Bitte RDF/XML und eine SPARQL-Abfrage eingeben.';
            return;
        }
        const sourceRevision = RdfSource.revision();
        const revision = sparqlRevision;
        const button = byId('runSparqlBtn');
        running = true;
        button.disabled = true;
        target.setAttribute('aria-busy', 'true');
        target.textContent = 'SPARQL-Abfrage läuft …';
        try {
            parsedXml(source);
            const rdflib = await loadRdflib();
            if (revision !== sparqlRevision || sourceRevision !== RdfSource.revision()) return;
            const store = rdflib.graph();
            rdflib.parse(source.rdfXml, store, source.documentIri || window.location.href, 'application/rdf+xml');
            const query = rdflib.SPARQLToQuery(queryText, true, store);
            if (!query) throw new Error('Die SPARQL-Abfrage konnte nicht gelesen werden.');
            showBindings(target, query, store.querySync(query));
        } catch (error) {
            if (revision === sparqlRevision && sourceRevision === RdfSource.revision()) target.textContent = 'SPARQL-Fehler: ' + error.message;
        } finally {
            running = false;
            button.disabled = false;
            target.removeAttribute('aria-busy');
        }
    }

    function selectMode(mode) {
        for (const name of ['xpath', 'sparql']) {
            const selected = name === mode;
            const tab = byId(name + 'Tab');
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            byId(name === 'xpath' ? 'paneXPath' : 'paneSparql').classList.toggle('d-none', !selected);
        }
    }

    for (const mode of ['xpath', 'sparql']) {
        const title = mode === 'xpath' ? 'XPath' : 'Sparql';
        byId(mode + 'QueryInput').value = defaults[mode];
        byId(mode + 'QueryInput').addEventListener('input', () => {
            if (mode === 'sparql') sparqlRevision++;
            byId(mode + 'QueryResult').textContent = 'Abfrage geändert. Bitte erneut ausführen.';
        });
        byId('load' + title + 'ExampleBtn').addEventListener('click', () => {
            byId(mode + 'QueryInput').value = defaults[mode];
            byId(mode + 'QueryInput').dispatchEvent(new Event('input'));
        });
        byId(mode + 'Tab').addEventListener('click', () => selectMode(mode));
        byId(mode + 'Tab').addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'xpath' : event.key === 'End' ? 'sparql' : mode === 'xpath' ? 'sparql' : 'xpath';
            selectMode(next);
            byId(next + 'Tab').focus();
        });
    }
    byId('runXPathBtn').addEventListener('click', runXPath);
    byId('runSparqlBtn').addEventListener('click', runSparql);
    RdfSource.subscribe(() => {
        xmlCache = null;
        sparqlRevision++;
        for (const mode of ['xpath', 'sparql']) byId(mode + 'QueryResult').textContent = 'RDF/XML geändert. Bitte die Abfrage erneut ausführen.';
    });
})();
