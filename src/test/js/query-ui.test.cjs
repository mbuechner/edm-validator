const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
let JSDOM;
try { ({JSDOM} = require(path.join(root, 'target/ui-check/node_modules/jsdom'))); }
catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    test('SPARQL query interface', {skip: 'Install optional jsdom tools.'}, () => {});
}
if (JSDOM) {
    const read = file => fs.readFileSync(path.join(root, 'src/main/resources/static', file), 'utf8');
    const portal = read('queries/portal-select.rq');
    const xml = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>';
    const flush = () => new Promise(resolve => setImmediate(resolve));
    function app(t, {example1 = false} = {}) {
        const dom = new JSDOM(read('query.html'), {url: 'https://validator.example/custom/tools/query.html', runScripts: 'outside-only'});
        const {window} = dom;
        t.after(() => { window.dispatchEvent(new window.Event('pagehide')); window.close(); });
        const workers = [];
        window.Worker = class {
            constructor(url, options) { this.url = url; this.options = options; this.messages = []; workers.push(this); }
            postMessage(message) { this.messages.push(message); }
            terminate() { this.terminated = true; }
            reply(packet) { this.onmessage?.({data: packet}); }
        };
        for (const file of ['messages.js', 'code-view.js', 'rdf-source.js', 'sparql-client.js']) window.eval(read(file));
        window.RdfSource.set({rdfXml: xml, documentIri: 'https://example.org/document.rdf'});
        window.eval(read('query.js'));
        const el = id => window.document.getElementById(id);
        const change = (id, value, event = 'input') => { el(id).value = value; el(id).dispatchEvent(new window.Event(event)); };
        const run = () => el('runSparqlBtn').click();
        const reply = (worker, message, extra = {}) => worker.reply({type: 'result', requestId: message.requestId,
            sourceId: message.sourceId, kind: 'select', rowCount: 1, json: '[{"title":"A & B <img src=x>"}]',
            timings: {initMs: 5, loadMs: 12.5, queryMs: 2.25, cacheHit: false}, tripleCount: 1, ...extra});
        if (example1) el('loadSparqlExample1Btn').click();
        return {window, el, change, run, workers, reply};
    }

    test('SPARQL starts with an empty editor and loads the simple example locally without changing RDF', t => {
        const a = app(t);
        let loads = 0;
        a.window.fetch = () => { loads++; throw new Error('The simple example must be available locally.'); };
        assert.equal(a.el('sparqlQueryInput').value, '');
        assert.equal(a.workers.length, 0);
        a.run();
        assert.equal(a.workers.length, 0, 'an empty editor starts neither a worker nor a query');
        assert.match(a.el('sparqlState').textContent, /SPARQL-Abfrage eingeben/);
        for (const removed of ['portalObjectOptions', 'portalObjectIri', 'applyPortalObjectBtn', 'portalObjectHint']) {
            assert.equal(a.el(removed), null, 'the object IRI helper has been removed');
        }
        assert.equal(a.el('loadSparqlExample1Btn').textContent, 'Beispiel 1');
        assert.equal(a.el('loadSparqlExample2Btn').textContent, 'Beispiel 2');
        a.el('loadSparqlExample1Btn').click();
        assert.match(a.el('sparqlQueryInput').value, /SELECT \?locationLabel/);
        assert.match(a.el('sparqlQueryInput').value, /\?object edm:currentLocation \?place/);
        assert.equal(a.window.RdfSource.get().rdfXml, xml);
        assert.equal(loads, 0);
        a.change('sparqlQueryInput', a.el('sparqlQueryInput').value + '\n# editable simple example');
        assert.match(a.el('sparqlQueryInput').value, /# editable simple example$/);
    });

    test('SPARQL uses one local module worker and the shared document base, then renders safe numbered flat JSON', async t => {
        const a = app(t, {example1: true});
        assert.equal(a.workers.length, 0, 'XPath requires no worker');
        a.run();
        const w = a.workers[0], request = w.messages[0];
        assert.equal(w.url.href, 'https://validator.example/custom/tools/sparql-worker.mjs');
        assert.equal(w.options.type, 'module');
        assert.equal(request.source.rdfXml, xml);
        assert.equal(request.source.baseIri, 'https://example.org/document.rdf');
        assert.equal(a.el('runSparqlBtn').disabled, true);
        for (const [phase, text] of [['initializing', /initialisiert/], ['loading', /Store geladen/], ['querying', /läuft/]]) {
            w.reply({type: 'status', requestId: request.requestId, sourceId: request.sourceId, phase});
            assert.match(a.el('sparqlState').textContent, text);
        }
        a.reply(w, request); await flush();
        const output = a.el('sparqlQueryResult');
        assert.deepEqual(JSON.parse(output.querySelector('code').textContent), [{title: 'A & B <img src=x>'}]);
        assert.equal(output.querySelector('img'), null);
        assert.equal(output.querySelector('.code-view-gutter').getAttribute('aria-hidden'), 'true');
        assert.match(a.el('sparqlMetrics').textContent, /RDF laden: 12,5 ms.*Abfrage: 2,25 ms/);
        assert.equal(a.el('runSparqlBtn').disabled, false);
        a.change('sparqlQueryInput', 'SELECT ?s WHERE { ?s ?p ?o }'); a.run();
        assert.equal(a.workers.length, 1);
        assert.equal(w.messages[1].source, undefined, 'changing a query does not resend or reload XML');
        a.reply(w, w.messages[1], {timings: {initMs: 0, loadMs: 0, queryMs: 1, cacheHit: true}}); await flush();
        assert.match(a.el('sparqlMetrics').textContent, /RDF laden: 0 ms.*Store wiederverwendet/);
    });

    test('data and base changes replace active queries; stale replies cannot overwrite a newer result', async t => {
        const a = app(t, {example1: true}); a.run();
        const w = a.workers[0], old = w.messages[0];
        a.window.RdfSource.set({rdfXml: xml.replace('/>', ' xml:base="https://new.example/"/>')});
        assert.equal(a.el('runSparqlBtn').disabled, false);
        a.run(); const changed = w.messages[1];
        assert.notEqual(changed.sourceId, old.sourceId);
        assert.ok(changed.source.rdfXml.includes('xml:base'));
        a.reply(w, changed, {json: '[{"new":"current"}]'}); await flush();
        a.reply(w, old, {json: '[{"old":"stale"}]'}); await flush();
        assert.equal(a.el('sparqlQueryResult').querySelector('code').textContent, '[{"new":"current"}]');
        a.window.RdfSource.set({...a.window.RdfSource.get(), documentIri: 'https://other.example/base.rdf'}); a.run();
        assert.equal(w.messages[2].source.baseIri, 'https://other.example/base.rdf');
        a.reply(w, w.messages[2]); await flush();
        a.run(); const pending = w.messages[3];
        a.change('sparqlQueryInput', 'ASK {}');
        a.reply(w, pending); await flush();
        assert.equal(a.el('sparqlQueryResult').classList.contains('d-none'), true);
        assert.match(a.el('sparqlState').textContent, /geändert/);
    });

    test('load and query errors show their stage, release the button and support retry', async t => {
        const a = app(t, {example1: true}); a.run(); const w = a.workers[0];
        for (const phase of ['loading', 'querying']) {
            const request = w.messages.at(-1);
            w.reply({type: 'error', requestId: request.requestId, sourceId: request.sourceId, phase,
                message: '<broken> at line 2', timings: {loadMs: 3, queryMs: 0}});
            await flush();
            assert.equal(a.el('runSparqlBtn').disabled, false);
            assert.match(a.el('sparqlState').textContent, phase === 'loading' ? /RDF\/XML konnte nicht/ : /Abfrage fehlgeschlagen/);
            assert.match(a.el('sparqlQueryResult').textContent, /<broken> at line 2/);
            assert.equal(a.el('sparqlQueryResult').querySelector('broken'), null);
            a.run();
        }
        a.reply(w, w.messages.at(-1), {rowCount: 0, json: '[]'}); await flush();
        assert.match(a.el('sparqlState').textContent, /0 Ergebniszeilen/);
    });

    test('XPath edits remain independent and query tabs keep keyboard navigation', async t => {
        const a = app(t, {example1: true});
        assert.deepEqual([...a.window.document.querySelectorAll('[role="tablist"] [role="tab"]')].map(tab => tab.id),
            ['sparqlTab', 'xpathTab']);
        const selected = mode => {
            for (const candidate of ['sparql', 'xpath']) {
                const active = candidate === mode;
                const tab = a.el(candidate + 'Tab');
                assert.equal(tab.classList.contains('active'), active);
                assert.equal(tab.getAttribute('aria-selected'), String(active));
                assert.equal(tab.tabIndex, active ? 0 : -1);
                assert.equal(a.el(candidate === 'sparql' ? 'paneSparql' : 'paneXPath').classList.contains('d-none'), !active);
            }
        };
        selected('sparql');
        a.run();
        a.change('xpathQueryInput', 'count(//rdf:Description)');
        a.reply(a.workers[0], a.workers[0].messages[0]); await flush();
        assert.match(a.el('sparqlState').textContent, /1 Ergebniszeile/);
        for (const [from, key, to] of [
            ['sparql', 'End', 'xpath'], ['xpath', 'Home', 'sparql'],
            ['sparql', 'ArrowRight', 'xpath'], ['xpath', 'ArrowLeft', 'sparql']
        ]) {
            a.el(from + 'Tab').dispatchEvent(new a.window.KeyboardEvent('keydown', {key, bubbles: true}));
            selected(to);
            assert.equal(a.window.document.activeElement.id, to + 'Tab');
        }
        assert.equal(a.el('loadSparqlExample1Btn').textContent, 'Beispiel 1');
        assert.equal(a.el('loadSparqlExample2Btn').textContent, 'Beispiel 2');
    });

    test('example 2 loads the entire editable portal query, preserves RDF and reuses its cached text', async t => {
        const a = app(t, {example1: true}); let loads = 0;
        const simple = a.el('sparqlQueryInput').value;
        a.window.fetch = async url => { loads++; assert.equal(url, './queries/portal-select.rq'); return {ok: true, text: async () => portal}; };
        const button = a.el('loadSparqlExample2Btn');
        assert.equal(button.title, 'RDF/XML → Portal-JSON');
        a.run(); const pending = a.workers[0].messages[0];
        button.click();
        assert.equal(button.disabled, true);
        assert.equal(button.getAttribute('aria-busy'), 'true');
        await flush();
        assert.equal(button.disabled, false);
        assert.equal(button.textContent, 'Beispiel 2');
        assert.equal(button.hasAttribute('aria-busy'), false);
        assert.equal(a.el('sparqlQueryInput').value, portal);
        assert.equal(a.window.RdfSource.get().rdfXml, xml, 'loading an example changes only the query');
        a.reply(a.workers[0], pending); await flush();
        assert.equal(a.el('sparqlQueryResult').classList.contains('d-none'), true, 'an older query cannot publish results for the loaded example');
        a.change('sparqlQueryInput', a.el('sparqlQueryInput').value + '\n# editable');
        assert.match(a.el('sparqlQueryInput').value, /# editable$/);
        a.el('loadSparqlExample1Btn').click();
        assert.equal(a.el('sparqlQueryInput').value, simple);
        button.click(); await flush();
        assert.equal(a.el('sparqlQueryInput').value, portal);
        assert.equal(a.window.RdfSource.get().rdfXml, xml);
        assert.equal(loads, 1, 'the complete example is fetched only once');
    });

    test('example fetch errors are retryable, and delayed examples never overwrite user edits', async t => {
        const a = app(t);
        a.window.fetch = async () => ({ok: false, status: 503});
        const button = a.el('loadSparqlExample2Btn');
        button.click(); await flush();
        assert.match(a.el('sparqlQueryResult').textContent, /HTTP 503/);
        assert.equal(button.disabled, false);
        let resolve;
        a.window.fetch = () => new Promise(done => { resolve = done; });
        button.click();
        a.change('sparqlQueryInput', 'SELECT * WHERE {} # user edit');
        resolve({ok: true, text: async () => portal}); await flush();
        assert.equal(a.el('sparqlQueryInput').value, 'SELECT * WHERE {} # user edit');
        assert.equal(button.disabled, false);
        assert.equal(button.textContent, 'Beispiel 2');
        assert.equal(button.hasAttribute('aria-busy'), false);
        assert.equal(a.window.RdfSource.get().rdfXml, xml);
    });

    test('a delayed portal example cannot replace example 1 and always releases the example 2 button', async t => {
        const a = app(t);
        let resolve;
        let loads = 0;
        a.window.fetch = () => { loads++; return new Promise(done => { resolve = done; }); };
        const portalButton = a.el('loadSparqlExample2Btn');
        portalButton.click();
        assert.equal(portalButton.disabled, true);
        assert.equal(portalButton.getAttribute('aria-busy'), 'true');
        a.el('loadSparqlExample1Btn').click();
        const simple = a.el('sparqlQueryInput').value;
        assert.match(simple, /SELECT \?locationLabel/);
        resolve({ok: true, text: async () => portal});
        await flush();
        assert.equal(a.el('sparqlQueryInput').value, simple, 'the newer local example wins over the older portal response');
        assert.equal(portalButton.disabled, false);
        assert.equal(portalButton.textContent, 'Beispiel 2');
        assert.equal(portalButton.hasAttribute('aria-busy'), false);
        assert.equal(a.window.RdfSource.get().rdfXml, xml);
        portalButton.click();
        await flush();
        assert.equal(a.el('sparqlQueryInput').value, portal, 'the portal button remains usable after its stale response');
        assert.equal(loads, 1, 'the late response is safely cached for an explicit later selection');
    });
}
