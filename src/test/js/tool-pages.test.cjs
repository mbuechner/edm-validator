const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
let JSDOM;
try { ({JSDOM} = require(path.join(root, 'target/ui-check/node_modules/jsdom'))); }
catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    test('Independent explorer and query pages', {skip: 'Install optional jsdom tools.'}, () => {});
}
if (JSDOM) {
    const read = name => fs.readFileSync(path.join(root, 'src/main/resources/static', name), 'utf8');
    const xml = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<rdf:Description rdf:about="item"><dc:title>A &amp; B</dc:title></rdf:Description></rdf:RDF>';
    const flush = () => new Promise(resolve => setImmediate(resolve));
    function page(t, name, initial = xml) {
        const dom = new JSDOM(read(name + '.html'), {url: 'https://validator.example/custom/tools/' + name + '.html', runScripts: 'outside-only'});
        const {window} = dom;
        t.after(() => window.close());
        window.eval(read('messages.js'));
        window.eval(read('code-view.js'));
        window.eval(read('rdf-source.js'));
        window.RdfSource.set({rdfXml: initial, documentIri: 'https://example.org/document.rdf'});
        return window;
    }
    function explorer(t, initial, { ignoreAbort = false } = {}) {
        const window = page(t, 'explorer', initial);
        const requests = [];
        const rendered = [];
        const timers = new Map();
        window.setTimeout = callback => { const id = Symbol(); timers.set(id, callback); return id; };
        window.clearTimeout = id => timers.delete(id);
        let hides = 0;
        window.RdfGraphExplorer = {hide() {hides++;}, async render(data) {rendered.push(data);}};
        window.fetch = (url, options) => new Promise((resolve, reject) => {
            if (!ignoreAbort) options.signal.addEventListener('abort', () => reject(new window.DOMException('Cancelled', 'AbortError')));
            requests.push({url, options, resolve, reject, body: JSON.parse(options.body)});
        });
        window.eval(read('explorer.js'));
        const submit = () => window.document.getElementById('explorerForm').dispatchEvent(new window.Event('submit', {cancelable: true}));
        return {window, requests, rendered, timers, submit, hides: () => hides};
    }
    test('opening the explorer uses the saved XML directly without calling validation or the DDB API', async t => {
        const app = explorer(t);
        app.submit();
        assert.equal(app.requests.length, 1);
        assert.equal(app.requests[0].url, './api/graph');
        assert.equal(app.requests[0].body.rdfXml, xml);
        assert.equal(app.requests[0].body.documentIri, 'https://example.org/document.rdf');
        app.requests[0].resolve({ok: true, json: async () => ({graphNodes: [{id: 'a'}, {id: 'b'}], graphLinks: [{source: 'a', target: 'b'}], error: null})});
        await flush();
        assert.equal(app.rendered.length, 1);
        assert.equal(app.window.document.getElementById('renderGraphBtn').disabled, false);
    });
    test('editing a source discards an old graph response and permits rebuilding the current document', async t => {
        const app = explorer(t);
        app.window.RdfSource.set({rdfXml: '<changed/>'});
        await flush();
        assert.equal(app.rendered.length, 0);
        assert.equal(app.requests[0].options.signal.aborted, true);
        app.submit();
        assert.equal(app.requests.length, 2);
        assert.equal(app.requests[1].body.rdfXml, '<changed/>');
        app.requests[1].resolve({ok: false, json: async () => ({error: 'Ungültiges RDF/XML'})});
        await flush();
        assert.match(app.window.document.getElementById('result').textContent, /Ungültiges RDF/);
        assert.equal(app.window.document.getElementById('rdfXmlInput').value, '<changed/>');
    });
    test('an empty explorer waits for source input and a network error permits retry', async t => {
        const app = explorer(t, '');
        assert.equal(app.requests.length, 0);
        app.window.RdfSource.set({rdfXml: xml}); app.submit();
        app.requests[0].reject(new Error('offline')); await flush();
        assert.equal(app.window.document.getElementById('renderGraphBtn').disabled, false);
        app.submit(); assert.equal(app.requests.length, 2);
        app.requests[1].resolve({ok: true, json: async () => ({graphNodes: [], graphLinks: [], error: null})}); await flush();
        assert.match(app.window.document.getElementById('result').textContent, /keine darstellbaren RDF-Verbindungen/);
        assert.equal(app.window.document.querySelector('#result .alert-success'), null);
    });

    test('a graph request that ignores abort cannot block its replacement or unlock its button later', async t => {
        const app = explorer(t, xml, { ignoreAbort: true });
        app.window.RdfSource.set({rdfXml: '<changed/>'});
        assert.equal(app.window.document.getElementById('renderGraphBtn').disabled, false);
        app.submit();
        assert.equal(app.requests.length, 2, 'a replacement starts without waiting for the cancelled response');
        app.requests[0].resolve({ok: true, json: async () => ({graphNodes: [{id: 'old'}], graphLinks: [{}]})});
        await flush();
        assert.equal(app.rendered.length, 0);
        assert.equal(app.window.document.getElementById('renderGraphBtn').disabled, true);
        app.requests[1].resolve({ok: true, json: async () => ({graphNodes: [{id: 'new'}], graphLinks: [{}]})});
        await flush();
        assert.equal(app.rendered.length, 1);
        assert.equal(app.rendered[0].graphNodes[0].id, 'new');
        assert.equal(app.timers.size, 0);
    });

    test('graph timeout and leaving the page release controls even when the transport ignores abort', async t => {
        const app = explorer(t, xml, { ignoreAbort: true });
        [...app.timers.values()][0]();
        assert.equal(app.window.document.getElementById('renderGraphBtn').disabled, false);
        assert.equal(app.requests[0].options.signal.aborted, true);
        assert.equal(app.timers.size, 0);
        assert.match(app.window.document.getElementById('result').textContent, /Zeitlimit/);
        app.submit();
        app.window.dispatchEvent(new app.window.Event('pagehide'));
        assert.equal(app.window.document.getElementById('renderGraphBtn').disabled, false);
        assert.equal(app.timers.size, 0);
        app.requests[1].resolve({ok: true, json: async () => ({graphNodes: [{id: 'late'}], graphLinks: [{}]})});
        await flush();
        assert.equal(app.rendered.length, 0);
    });
    test('XPath works immediately on unvalidated input, supports scalar and node results, and renders safe text', t => {
        const window = page(t, 'query');
        window.fetch = () => {throw new Error('XPath must not call a backend.');};
        window.eval(read('query.js'));
        const input = window.document.getElementById('xpathQueryInput');
        const result = window.document.getElementById('xpathQueryResult');
        input.value = 'count(//dc:title)';
        window.document.getElementById('runXPathBtn').click();
        assert.match(result.textContent, /1 Treffer1/);
        input.value = '//dc:title/text()';
        window.document.getElementById('runXPathBtn').click();
        assert.match(result.textContent, /A & B/);
        assert.equal(result.querySelector('dc\\:title'), null);
        input.value = '//dc:title';
        window.document.getElementById('runXPathBtn').click();
        assert.match(result.querySelector('pre.code-view code').textContent, /<dc:title/);
        assert.equal(result.querySelector('.code-view-gutter').getAttribute('aria-hidden'), 'true');
        window.RdfSource.set({rdfXml: '<broken>'});
        window.document.getElementById('runXPathBtn').click();
        assert.match(result.textContent, /XPath-Fehler/);
        assert.equal(window.document.getElementById('runXPathBtn').disabled, false);
    });

    test('repeated XPath queries reuse one parsed document and invalidate the cache on source changes', t => {
        const window = page(t, 'query', xml.replace('A &amp; B', 'x'.repeat(200000)));
        const NativeParser = window.DOMParser;
        let parses = 0;
        window.DOMParser = class {
            parseFromString(...args) { parses++; return new NativeParser().parseFromString(...args); }
        };
        window.eval(read('query.js'));
        const input = window.document.getElementById('xpathQueryInput');
        for (let index = 0; index < 20; index++) {
            input.value = index % 2 ? 'count(//dc:title)' : 'count(//rdf:Description)';
            input.dispatchEvent(new window.Event('input'));
            window.document.getElementById('runXPathBtn').click();
        }
        assert.equal(parses, 1);
        assert.match(window.document.getElementById('xpathQueryResult').textContent, /1 Treffer1/);
        const uri = window.document.getElementById('ddbUri');
        uri.value = 'https://ddb.example/candidate';
        uri.dispatchEvent(new window.Event('input'));
        window.document.getElementById('runXPathBtn').click();
        assert.equal(parses, 1, 'a candidate URI does not change the parsed source');
        window.RdfSource.set({rdfXml: xml.replace('<dc:title>A &amp; B</dc:title>', '<dc:title>A</dc:title><dc:title>B</dc:title>')});
        input.value = 'count(//dc:title)';
        window.document.getElementById('runXPathBtn').click();
        assert.equal(parses, 2);
        assert.match(window.document.getElementById('xpathQueryResult').textContent, /1 Treffer2/);
        t.diagnostic('20 queries on a 200 kB XML source: 1 XML parse instead of 20; the next source is parsed separately.');
    });
    function queryModule(window, load) {
        // Simulate script transport, keeping the real lazy loader and query execution.
        const append = window.document.head.append.bind(window.document.head);
        window.document.head.append = (...nodes) => {
            append(...nodes);
            for (const node of nodes) {
                if (node.tagName !== 'SCRIPT' || !node.src.endsWith('/vendor/rdflib-2.4.0.min.js')) continue;
                Promise.resolve().then(() => load(node.src)).then(library => {
                    window.$rdf = library;
                    node.dispatchEvent(new window.Event('load'));
                }, () => node.dispatchEvent(new window.Event('error')));
            }
        };
        window.eval(read('query.js'));
    }
    test('SPARQL uses the shared document base and does not depend on validation', async t => {
        const window = page(t, 'query');
        let parsed;
        const store = {querySync() {return [{'?title': {toNT: () => '"<img src=x>"'}}];}};
        const library = {graph: () => store, parse(...args) {parsed = args;}, SPARQLToQuery: () => ({vars: [{toNT: () => '?title'}]})};
        queryModule(window, async () => library);
        window.document.getElementById('runSparqlBtn').click(); await flush();
        assert.equal(parsed[0], xml);
        assert.equal(parsed[2], 'https://example.org/document.rdf');
        const result = window.document.getElementById('sparqlQueryResult');
        assert.match(result.textContent, /<img src=x>/);
        assert.equal(result.querySelector('img'), null);
        assert.equal(result.querySelectorAll('tbody tr').length, 1);
    });

    test('the vendored rdflib runs a real XML SELECT query and is loaded only once from this application', async t => {
        const window = page(t, 'query');
        const scripts = () => [...window.document.querySelectorAll('script[src="./vendor/rdflib-2.4.0.min.js"]')];
        let loads = 0;
        queryModule(window, url => {
            loads++;
            assert.equal(new URL(url).origin, window.location.origin);
            window.eval(read('vendor/rdflib-2.4.0.min.js'));
            return window.$rdf;
        });
        assert.equal(scripts().length, 0, 'XPath needs no RDF library');
        const input = window.document.getElementById('sparqlQueryInput');
        input.value = 'PREFIX dc: <http://purl.org/dc/elements/1.1/> SELECT ?s ?title WHERE { ?s dc:title ?title . }';
        input.dispatchEvent(new window.Event('input'));
        window.document.getElementById('runSparqlBtn').click();
        await flush();
        const result = window.document.getElementById('sparqlQueryResult');
        assert.equal(result.querySelectorAll('tbody tr').length, 1);
        assert.match(result.textContent, /A & B/);
        assert.match(result.textContent, /https:\/\/example.org\/item/, 'relative RDF IRIs use the original document base');
        window.document.getElementById('runSparqlBtn').click();
        await flush();
        assert.equal(loads, 1);
        assert.equal(scripts().length, 1);
        assert.equal(window.document.getElementById('runSparqlBtn').disabled, false);
    });

    test('a failed local RDF library load removes its script and can be retried', async t => {
        const window = page(t, 'query');
        let attempts = 0;
        queryModule(window, () => {
            if (++attempts === 1) throw new Error('Script unavailable');
            return {graph: () => ({querySync: () => []}), parse() {}, SPARQLToQuery: () => ({vars: []})};
        });
        window.document.getElementById('runSparqlBtn').click();
        await flush();
        assert.match(window.document.getElementById('sparqlQueryResult').textContent, /Bibliothek konnte nicht geladen/);
        assert.equal(window.document.querySelectorAll('script[src="./vendor/rdflib-2.4.0.min.js"]').length, 0);
        assert.equal(window.document.getElementById('runSparqlBtn').disabled, false);
        window.document.getElementById('runSparqlBtn').click();
        await flush();
        assert.equal(attempts, 2);
        assert.match(window.document.getElementById('sparqlQueryResult').textContent, /keine Treffer/);
    });

    test('a local RDF library timeout releases the query button even without a transport response', async t => {
        const window = page(t, 'query');
        const timers = new Map();
        window.setTimeout = callback => { const id = Symbol(); timers.set(id, callback); return id; };
        window.clearTimeout = id => timers.delete(id);
        queryModule(window, () => new Promise(() => {}));
        window.document.getElementById('runSparqlBtn').click();
        [...timers.values()][0]();
        await flush();
        assert.equal(window.document.getElementById('runSparqlBtn').disabled, false);
        assert.equal(timers.size, 0);
        assert.match(window.document.getElementById('sparqlQueryResult').textContent, /Bibliothek konnte nicht geladen/);
    });
    test('a source edit while SPARQL loads suppresses the stale result and the next query uses the new source', async t => {
        const window = page(t, 'query');
        let resolveModule;
        let parses = 0;
        const pending = new Promise(resolve => {resolveModule = resolve;});
        const library = {graph: () => ({querySync: () => []}), parse() {parses++;}, SPARQLToQuery: () => ({vars: []})};
        queryModule(window, () => pending);
        window.document.getElementById('runSparqlBtn').click();
        window.RdfSource.set({rdfXml: xml.replace('A &amp; B', 'New')});
        resolveModule(library); await flush();
        assert.equal(parses, 0);
        assert.match(window.document.getElementById('sparqlQueryResult').textContent, /RDF\/XML geändert/);
        window.document.getElementById('runSparqlBtn').click(); await flush();
        assert.equal(parses, 1);
        assert.equal(window.document.getElementById('runSparqlBtn').disabled, false);
    });
    test('editing XPath does not cancel an independent pending SPARQL query', async t => {
        const window = page(t, 'query');
        let resolveModule;
        const pending = new Promise(resolve => {resolveModule = resolve;});
        let parses = 0;
        queryModule(window, () => pending);
        window.document.getElementById('runSparqlBtn').click();
        window.document.getElementById('xpathQueryInput').value = 'count(//dc:title)';
        window.document.getElementById('xpathQueryInput').dispatchEvent(new window.Event('input'));
        resolveModule({graph: () => ({querySync: () => []}), parse() {parses++;}, SPARQLToQuery: () => ({vars: []})});
        await flush();
        assert.equal(parses, 1);
        assert.match(window.document.getElementById('sparqlQueryResult').textContent, /keine Treffer/);
    });
    test('query tabs support keyboard navigation and query examples invalidate pending results', t => {
        const window = page(t, 'query');
        window.eval(read('query.js'));
        window.document.getElementById('xpathTab').dispatchEvent(new window.KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
        assert.equal(window.document.getElementById('sparqlTab').getAttribute('aria-selected'), 'true');
        assert.equal(window.document.activeElement.id, 'sparqlTab');
        assert.equal(window.document.getElementById('paneSparql').classList.contains('d-none'), false);
        window.document.getElementById('sparqlQueryInput').value = 'changed';
        window.document.getElementById('loadSparqlExampleBtn').click();
        assert.match(window.document.getElementById('sparqlQueryInput').value, /SELECT/);
    });
}
