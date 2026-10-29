/* Browser queries read the current shared document; no validation result is required. */
(() => {
    'use strict';
    const byId = id => document.getElementById(id);
    if (!byId('queryWorkspace') || !window.RdfSource) return;
    const examples = {
        xpath: '//dc:title/text()',
        sparql: `PREFIX edm:  <http://www.europeana.eu/schemas/edm/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

SELECT ?locationLabel
WHERE {
  ?object edm:currentLocation ?place .
  ?place skos:prefLabel ?locationLabel .
}`
    };
    let sparqlRevision = 0;
    let sparqlRun = 0;
    let sparqlBusy = false;
    let client = null;
    let exampleRevision = 0;
    let portalQueryPromise = null;
    let xmlCache = null;

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

    const phaseLabels = {
        initializing: 'Oxigraph wird initialisiert …',
        loading: 'RDF/XML wird in den Store geladen …',
        querying: 'SPARQL-Abfrage läuft …'
    };

    function setSparqlBusy(busy) {
        sparqlBusy = busy;
        byId('runSparqlBtn').disabled = busy;
        if (busy) byId('sparqlQueryResult').setAttribute('aria-busy', 'true');
        else byId('sparqlQueryResult').removeAttribute('aria-busy');
    }

    function clearSparqlResult(message) {
        const target = byId('sparqlQueryResult');
        target.replaceChildren();
        target.classList.add('d-none');
        byId('sparqlMetrics').classList.add('d-none');
        byId('sparqlState').textContent = message;
    }

    function invalidateSparql(message) {
        sparqlRevision++;
        sparqlRun++;
        client?.invalidate();
        setSparqlBusy(false);
        clearSparqlResult(message);
    }

    function queryClient() {
        if (!client) {
            if (!window.SparqlClient) throw new Error('Der SPARQL-Worker konnte nicht vorbereitet werden. Bitte die Seite neu laden.');
            client = window.SparqlClient.create({ onStatus(status) {
                if (sparqlBusy) byId('sparqlState').textContent = phaseLabels[status.phase] || 'Abfrage wird vorbereitet …';
            }});
        }
        return client;
    }

    const milliseconds = value => Number.isFinite(value)
        ? new Intl.NumberFormat('de-DE', {maximumFractionDigits: 2}).format(value) + ' ms' : '–';

    function showTimings(timings, tripleCount) {
        if (!timings) return;
        const parts = ['RDF laden: ' + milliseconds(timings.loadMs), 'Abfrage: ' + milliseconds(timings.queryMs)];
        if (timings.initMs > 0) parts.push('Oxigraph initialisieren: ' + milliseconds(timings.initMs));
        if (timings.cacheHit) parts.push('Store wiederverwendet');
        if (Number.isFinite(tripleCount)) parts.push(tripleCount + ' Tripel');
        byId('sparqlMetrics').textContent = parts.join(' · ');
        byId('sparqlMetrics').classList.remove('d-none');
    }

    async function runSparql() {
        if (sparqlBusy) return;
        const source = RdfSource.get();
        const queryText = byId('sparqlQueryInput').value.trim();
        if (!source.rdfXml.trim() || !queryText) {
            clearSparqlResult('Bitte RDF/XML und eine SPARQL-Abfrage eingeben.');
            return;
        }
        const sourceRevision = RdfSource.revision();
        const revision = sparqlRevision;
        const run = ++sparqlRun;
        const current = () => run === sparqlRun && revision === sparqlRevision && sourceRevision === RdfSource.revision();
        clearSparqlResult('Abfrage wird vorbereitet …');
        setSparqlBusy(true);
        try {
            const result = await queryClient().query({rdfXml: source.rdfXml, baseIri: source.documentIri || window.location.href}, queryText);
            if (!current()) return;
            const target = byId('sparqlQueryResult');
            const pre = document.createElement('pre');
            pre.className = 'source-code border rounded bg-body-tertiary p-3 mb-0 overflow-auto';
            pre.setAttribute('aria-label', 'SPARQL-Ergebnis als JSON');
            if (window.CodeView) CodeView.render(pre, result.json, 'json');
            else pre.textContent = result.json;
            target.replaceChildren(pre);
            target.classList.remove('d-none');
            byId('sparqlResultHeading').textContent = result.kind === 'graph' ? 'JSON-LD-Ergebnis' : 'JSON-Ergebnis';
            byId('sparqlState').textContent = result.kind === 'select'
                ? result.rowCount + (result.rowCount === 1 ? ' Ergebniszeile.' : ' Ergebniszeilen.') : 'Abfrage abgeschlossen.';
            showTimings(result.timings, result.tripleCount);
        } catch (error) {
            if (!current() || error.name === 'AbortError') return;
            byId('sparqlState').textContent = error.phase === 'loading' ? 'RDF/XML konnte nicht geladen werden.' : 'SPARQL-Abfrage fehlgeschlagen.';
            const target = byId('sparqlQueryResult');
            if (window.AppMessages) AppMessages.show(target, 'danger', error.message);
            else { target.textContent = error.message; target.classList.remove('d-none'); }
            showTimings(error.timings);
        } finally {
            if (current()) setSparqlBusy(false);
        }
    }

    function portalQuery() {
        if (!portalQueryPromise) portalQueryPromise = fetch('./queries/portal-select.rq')
            .then(async response => {
                if (!response.ok) throw new Error('Die Portal-Beispielabfrage konnte nicht geladen werden (HTTP ' + response.status + ').');
                const text = await response.text();
                if (!text.trim()) throw new Error('Die Portal-Beispielabfrage ist leer.');
                return text;
            }).catch(error => { portalQueryPromise = null; throw error; });
        return portalQueryPromise;
    }

    function setSparqlExample(text) {
        byId('sparqlQueryInput').value = text;
        invalidateSparql('Beispiel geladen. Die Abfrage kann bearbeitet und ausgeführt werden.');
    }

    async function loadPortalExample() {
        const button = byId('loadSparqlExample2Btn');
        const request = ++exampleRevision;
        const revision = sparqlRevision;
        button.disabled = true;
        button.textContent = 'Wird geladen …';
        button.setAttribute('aria-busy', 'true');
        try {
            const text = await portalQuery();
            if (request !== exampleRevision || revision !== sparqlRevision) return;
            setSparqlExample(text);
        } catch (error) {
            if (request !== exampleRevision || revision !== sparqlRevision) return;
            clearSparqlResult('Beispielabfrage konnte nicht geladen werden.');
            AppMessages.show(byId('sparqlQueryResult'), 'danger', error.message);
        } finally {
            if (request === exampleRevision) {
                button.disabled = false;
                button.textContent = 'Beispiel 2';
                button.removeAttribute('aria-busy');
            }
        }
    }

    function selectMode(mode) {
        for (const name of ['sparql', 'xpath']) {
            const selected = name === mode;
            const tab = byId(name + 'Tab');
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            byId(name === 'xpath' ? 'paneXPath' : 'paneSparql').classList.toggle('d-none', !selected);
        }
    }

    byId('xpathQueryInput').value = examples.xpath;
    for (const mode of ['sparql', 'xpath']) {
        byId(mode + 'QueryInput').addEventListener('input', () => {
            if (mode === 'sparql') invalidateSparql('Abfrage geändert. Bitte erneut ausführen.');
            else byId('xpathQueryResult').textContent = 'Abfrage geändert. Bitte erneut ausführen.';
        });
        byId(mode + 'Tab').addEventListener('click', () => selectMode(mode));
        byId(mode + 'Tab').addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'sparql' : event.key === 'End' ? 'xpath' : mode === 'xpath' ? 'sparql' : 'xpath';
            selectMode(next);
            byId(next + 'Tab').focus();
        });
    }
    byId('runXPathBtn').addEventListener('click', runXPath);
    byId('loadXPathExampleBtn').addEventListener('click', () => {
        byId('xpathQueryInput').value = examples.xpath;
        byId('xpathQueryInput').dispatchEvent(new Event('input'));
    });
    byId('runSparqlBtn').addEventListener('click', runSparql);
    byId('loadSparqlExample1Btn').addEventListener('click', () => setSparqlExample(examples.sparql));
    byId('loadSparqlExample2Btn').addEventListener('click', loadPortalExample);
    RdfSource.subscribe(() => {
        xmlCache = null;
        byId('xpathQueryResult').textContent = 'RDF/XML geändert. Bitte die Abfrage erneut ausführen.';
        invalidateSparql('RDF/XML geändert. Bitte die Abfrage erneut ausführen.');
    });
    window.addEventListener('pagehide', () => {
        sparqlRun++;
        client?.invalidate();
        setSparqlBusy(false);
    });
})();
