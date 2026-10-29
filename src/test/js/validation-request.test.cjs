const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
let JSDOM;
try { ({JSDOM} = require(path.join(root, 'target/ui-check/node_modules/jsdom'))); }
catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    test('Validation request DOM tests', {skip: 'Install optional jsdom tools.'}, () => {});
}
if (JSDOM) {
    const read = name => fs.readFileSync(path.join(root, 'src/main/resources/static', name), 'utf8');
    const xml = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>';
    const result = {overallPassed: true, xmlSyntaxPassed: true, edmXsdPassed: true, rdfSyntaxPassed: true,
        shaclPassed: true, results: [], message: 'Validierung erfolgreich'};
    function harness(t) {
        const dom = new JSDOM(read('validation.html'), {url: 'https://validator.example/app/edm-validator/validation.html', runScripts: 'outside-only'});
        const {window} = dom;
        t.after(() => window.close());
        window.eval(read('messages.js'));
        window.eval(read('code-view.js'));
        window.eval(read('rdf-source.js'));
        window.RdfSource.set({rdfXml: xml, ddbUri: 'https://www.deutsche-digitale-bibliothek.de/item/EXAMPLE', documentIri: 'https://example.org/source.rdf'});
        const requests = [];
        const timers = new Map();
        window.setTimeout = callback => { const id = Symbol(); timers.set(id, callback); return id; };
        window.clearTimeout = id => timers.delete(id);
        window.fetch = (url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new window.DOMException('Timed out', 'AbortError')));
            requests.push({url, options, body: JSON.parse(options.body), resolve, reject});
        });
        window.eval(read('validation.js'));
        const form = window.document.getElementById('validationForm');
        const submit = () => form.dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true}));
        const flush = () => new Promise(resolve => setImmediate(resolve));
        const complete = (index = 0, data = result) => requests[index].resolve({ok: true, text: async () => JSON.stringify(data)});
        return {window, form, requests, timers, submit, flush, complete, button: form.querySelector('button')};
    }
    test('validation uses current shared XML exactly once without another DDB download', async t => {
        const app = harness(t);
        app.submit(); app.submit();
        assert.equal(app.requests.length, 1);
        assert.equal(app.requests[0].url, './api/validate');
        assert.equal(app.requests[0].body.rdfXml, xml);
        assert.equal(app.requests[0].body.ddbUri, null);
        assert.equal(app.requests[0].body.documentIri, 'https://example.org/source.rdf');
        assert.equal(app.button.disabled, true);
        app.complete(); await app.flush();
        assert.equal(app.button.disabled, false);
        assert.equal(app.timers.size, 0);
        assert.match(app.window.document.getElementById('result').textContent, /erfolgreich/);
        assert.equal(app.window.document.querySelectorAll('#checklistItems li').length, 4);
        app.submit(); assert.equal(app.requests.length, 2);
        app.complete(1); await app.flush();
    });
    test('an edit invalidates pending results without abandoning the server response', async t => {
        const app = harness(t);
        app.submit();
        app.window.RdfSource.set({rdfXml: '<changed/>'});
        assert.equal(app.requests[0].options.signal.aborted, false);
        app.complete(); await app.flush();
        assert.equal(app.window.document.getElementById('checklist').classList.contains('d-none'), true);
        assert.match(app.window.document.getElementById('result').textContent, /Eingabe wurde geändert/);
        assert.equal(app.button.disabled, false);
    });
    test('successful engine reports stay compact while failed diagnostics open immediately', async t => {
        const app = harness(t);
        app.submit();
        app.complete(0, {...result, results: [{section: 'XML', engine: 'Parser', success: true, originalMessage: 'Gültiges XML'}]});
        await app.flush();
        const details = app.window.document.getElementById('details');
        assert.equal(details.open, false);
        assert.match(details.textContent, /Gültiges XML/);
        app.submit();
        app.complete(1, {...result, overallPassed: false, shaclPassed: false,
            results: [{section: 'SHACL', engine: 'Jena', success: false, originalMessage: '<img src=x> fehlt'}]});
        await app.flush();
        assert.equal(details.open, true);
        assert.match(details.textContent, /<img src=x> fehlt/);
        assert.equal(details.querySelector('img'), null);
        assert.equal(details.querySelector('pre.code-view code').textContent, '<img src=x> fehlt');
        assert.equal(details.querySelector('.code-view-gutter').getAttribute('aria-hidden'), 'true');
    });
    test('URI typing does not change the XML being validated or invalidate its result', async t => {
        const app = harness(t);
        app.submit();
        const uri = app.window.document.getElementById('ddbUri');
        uri.value = 'https://www.deutsche-digitale-bibliothek.de/item/OTHER';
        uri.dispatchEvent(new app.window.Event('input', {bubbles: true}));
        app.complete(); await app.flush();
        assert.match(app.window.document.getElementById('result').textContent, /erfolgreich/);
    });
    test('network errors and timeouts release the button and allow retry', async t => {
        for (const fail of [app => app.requests[0].reject(new Error('Network unavailable')), app => [...app.timers.values()][0]()]) {
            const app = harness(t);
            app.submit(); fail(app); await app.flush();
            assert.equal(app.button.disabled, false);
            assert.equal(app.form.hasAttribute('aria-busy'), false);
            assert.equal(app.timers.size, 0);
            assert.match(app.window.document.getElementById('result').textContent, /Fehler/);
            app.submit(); app.complete(1); await app.flush();
        }
    });
    test('empty XML does not run validation even when a DDB URI has been entered', async t => {
        const app = harness(t);
        app.window.RdfSource.set({rdfXml: ''}); app.submit();
        await app.flush();
        assert.equal(app.requests.length, 0);
        assert.equal(app.window.document.activeElement.id, 'rdfXmlInput');
    });
}
