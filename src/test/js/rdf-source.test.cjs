// Optional DOM tests: npm install --no-save --prefix target/ui-check jsdom@26.1.0
// Run: node --test src/test/js/rdf-source.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
let JSDOM;
try { ({ JSDOM } = require(path.join(root, 'target/ui-check/node_modules/jsdom'))); }
catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    test('Shared RDF source DOM tests', { skip: 'Install optional test tools: jsdom@26.1.0 in target/ui-check' }, () => {});
}

if (JSDOM) {
    const sourceScript = fs.readFileSync(path.join(root, 'src/main/resources/static/rdf-source.js'), 'utf8');
    const bootstrapFile = path.join(root, 'target/bootstrap.bundle.min.js');
    const bootstrapScript = fs.existsSync(bootstrapFile) ? fs.readFileSync(bootstrapFile, 'utf8') : null;
    const key = 'ddb-rdf-source-v1';
    const xml = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>';
    const plain = value => JSON.parse(JSON.stringify(value));
    const settled = () => new Promise(resolve => setImmediate(resolve));
    const deferred = () => {
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        return { promise, resolve, reject };
    };
    const response = (body, ok = true) => ({ ok, json: async () => body });

    function harness(t, options = {}) {
        const dom = new JSDOM('<main><section id="rdfSource" class="mb-4"></section><h1>Werkzeug</h1></main>', {
            url: 'https://validator.example/app/converter.html', runScripts: 'outside-only'
        });
        const { window } = dom;
        window.TextDecoder = TextDecoder;
        const storage = window.localStorage;
        for (const [name, value] of Object.entries(options.seed || {})) storage.setItem(name, value);
        if (options.handoff !== undefined) window.sessionStorage.setItem('ddb-edm-converter-handoff-v1', options.handoff);
        const calls = [], timers = new Map(), events = [];
        let timerId = 0;
        window.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
        window.clearTimeout = id => timers.delete(id);
        window.fetch = (url, config) => {
            const call = { url, ...config };
            calls.push(call);
            return options.fetch ? options.fetch(call) : Promise.resolve(response({ rdfXml: xml, ddbUri: 'https://ddb.example/item', apiUrl: 'https://api.example/source.rdf' }));
        };
        window.document.addEventListener('rdf-source-change', event => events.push(plain(event.detail)));
        options.beforeLoad?.(window, storage);
        if (options.bootstrap) window.eval(bootstrapScript);
        window.eval(sourceScript);
        t.after(() => window.close());
        const get = id => window.document.getElementById(id);
        const input = (id, value) => {
            get(id).value = value;
            get(id).dispatchEvent(new window.Event('input', { bubbles: true }));
        };
        const upload = async file => {
            Object.defineProperty(get('rdfFile'), 'files', { configurable: true, value: [file] });
            get('rdfFile').dispatchEvent(new window.Event('change', { bubbles: true }));
            await settled();
        };
        return { window, storage, get, input, upload, calls, timers, events,
            api: window.RdfSource, state: () => plain(window.RdfSource.get()) };
    }

    function file(bytes, name = 'source.rdf') {
        const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
        return { name, size: data.length, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    }

    test('shared Bootstrap accordion starts with RDF/XML and keeps the optional DDB setting closed', t => {
        const app = harness(t);
        assert.equal(app.get('rdfSourceBody').querySelector('input,textarea,button').id, 'rdfXmlInput');
        assert.equal(app.get('rdfSourceHeading').tagName, 'H2');
        assert.ok(app.get('rdfSourceHeading').classList.contains('accordion-header'));
        assert.equal(app.get('rdfSourceToggle').textContent, 'RDF/XML');
        assert.equal(app.get('rdfSourceToggle').dataset.bsToggle, 'collapse');
        assert.equal(app.get('rdfSourceToggle').getAttribute('aria-controls'), 'rdfSourceBody');
        assert.ok(app.get('rdfSourceBody').classList.contains('show'), 'an empty source starts open');
        assert.equal(app.get('rdfXmlInput').rows, 12);
        assert.ok(app.get('rdfXmlInput').classList.contains('form-control'));
        assert.ok(app.get('rdfXmlInput').classList.contains('source-code'));
        assert.equal(app.get('europeanaProfile').closest('details').open, false);
        assert.equal(app.get('rdfFile').accept.includes('.xml'), true);
        assert.equal(app.get('rdfFile').accept.includes('.owl'), true);
        assert.equal(Object.isFrozen(app.api), true);
        assert.deepEqual(app.state(), { rdfXml: '', ddbUri: '', documentIri: null });
    });

    test('candidate URI changes persist without invalidating tools; content and base changes publish snapshots', t => {
        const app = harness(t);
        const received = [];
        const unsubscribe = app.api.subscribe((value, revision) => received.push({ value: plain(value), revision }));
        const before = app.api.revision();
        app.input('ddbUri', 'https://ddb.example/new');
        assert.equal(app.api.revision(), before);
        assert.equal(app.events.length, 0);
        assert.equal(JSON.parse(app.storage.getItem(key)).ddbUri, 'https://ddb.example/new');
        app.api.set({ rdfXml: xml, documentIri: 'https://api.example/base.rdf' });
        assert.equal(app.api.revision(), before + 1);
        assert.equal(received.length, 1);
        assert.equal(app.events.at(-1).revision, received.at(-1).revision);
        assert.equal(received.at(-1).value.documentIri, 'https://api.example/base.rdf');
        app.input('rdfXmlInput', xml + '\n');
        assert.equal(app.state().documentIri, 'https://api.example/base.rdf', 'editing preserves the base for relative IRIs');
        assert.equal(received.length, 2);
        unsubscribe();
        app.api.set({ rdfXml: xml });
        assert.equal(received.length, 2);
        assert.equal(app.state().documentIri, null, 'a replacement without source metadata has no inherited base');
        const revision = app.api.revision();
        app.api.set({ rdfXml: xml });
        assert.equal(app.api.revision(), revision, 'the same document and metadata do not invalidate results');
    });

    test('input survives page navigation and clearing persists an authoritative empty source', t => {
        const app = harness(t, { seed: { 'ddb-edm-validator-xml': '<legacy/>' } });
        app.input('rdfXmlInput', xml + '\n');
        app.input('ddbUri', 'https://ddb.example/candidate');
        app.window.dispatchEvent(new app.window.Event('pagehide'));
        const saved = app.storage.getItem(key);
        const restored = harness(t, { seed: { [key]: saved } });
        assert.deepEqual(restored.state(), app.state());
        restored.get('clearRdfBtn').click();
        assert.deepEqual(restored.state(), { rdfXml: '', ddbUri: '', documentIri: null });
        const empty = restored.storage.getItem(key);
        assert.equal(JSON.parse(empty).rdfXml, '');
        const reloaded = harness(t, { seed: { [key]: empty, 'ddb-edm-validator-xml': '<legacy/>',
            'ddb-edm-converter-input-v1': JSON.stringify({ rdfXml: '<old-conversion/>' }) },
            handoff: JSON.stringify({ rdfXml: '<old-handoff/>' }) });
        assert.equal(reloaded.state().rdfXml, '');
        assert.equal(reloaded.window.sessionStorage.getItem('ddb-edm-converter-handoff-v1'), null);
    });

    test('legacy handoff and drafts migrate once, including the base needed for relative RDF IRIs', t => {
        const converter = JSON.stringify({ rdfXml: '<converter/>', baseIri: 'https://example.org/base/', documentIri: null });
        const app = harness(t, { seed: { 'ddb-edm-converter-input-v1': converter, 'ddb-edm-validator-xml': '<validator/>',
            'ddb-edm-validator-uri': 'https://ddb.example/item' } });
        assert.deepEqual(app.state(), { rdfXml: '<converter/>', ddbUri: 'https://ddb.example/item', documentIri: 'https://example.org/base/' });
        assert.ok(app.storage.getItem(key));
        const handoff = harness(t, { handoff: JSON.stringify({ rdfXml: '<handoff/>', documentIri: 'https://example.org/doc.rdf' }),
            seed: { 'ddb-edm-converter-input-v1': converter } });
        assert.equal(handoff.state().rdfXml, '<handoff/>');
        assert.equal(handoff.state().documentIri, 'https://example.org/doc.rdf');
        const damaged = harness(t, { seed: { [key]: 'invalid json', 'ddb-edm-validator-xml': '<stale/>' } });
        assert.equal(damaged.state().rdfXml, '');
        assert.equal(JSON.parse(damaged.storage.getItem(key)).rdfXml, '');
    });

    test('blocked or full persistent storage shows a hint while input remains usable', t => {
        for (const failure of ['blocked', 'quota']) {
            const app = harness(t, { beforeLoad(window) {
                if (failure === 'blocked') Object.defineProperty(window, 'localStorage', { get() { throw new window.DOMException('Blocked', 'SecurityError'); } });
                else window.Storage.prototype.setItem = () => { throw new window.DOMException('Full', 'QuotaExceededError'); };
            } });
            app.input('rdfXmlInput', xml);
            app.window.dispatchEvent(new app.window.Event('pagehide'));
            assert.equal(app.state().rdfXml, xml);
            assert.equal(app.get('rdfSourceStorageHint').classList.contains('d-none'), false);
            assert.ok(app.get('rdfSourceStorageHint').textContent.includes('nicht gespeichert'));
        }
    });

    test('XML upload honors declared legacy encoding and UTF-16 byte order, then stores UTF-8 text', async t => {
        const app = harness(t);
        const latin = '<?xml version="1.0" encoding="ISO-8859-1"?><name>München &amp; Straße</name>';
        await app.upload(file(Buffer.from(latin, 'latin1')));
        assert.equal(app.state().rdfXml, latin.replace('ISO-8859-1', 'UTF-8'));
        const utf16 = '<?xml version="1.0" encoding="UTF-16"?><name>Grüße</name>';
        for (const bigEndian of [false, true]) {
            const data = Buffer.from(utf16, 'utf16le');
            if (bigEndian) data.swap16();
            const bytes = Buffer.concat([Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]), data]);
            await app.upload(file(bytes));
            assert.equal(app.state().rdfXml, utf16.replace('UTF-16', 'UTF-8'));
        }
        const reloaded = harness(t, { seed: { [key]: app.storage.getItem(key) } });
        assert.deepEqual(reloaded.state(), app.state());
    });

    test('upload errors preserve the current document and its base; a successful upload replaces that base', async t => {
        const app = harness(t);
        app.api.set({ rdfXml: xml, documentIri: 'https://example.org/original.rdf' });
        for (const invalid of [
            { name: 'large.xml', size: 1024 * 1024 + 1, arrayBuffer: () => assert.fail('Oversize file must not be read') },
            file(Buffer.from([0xff])), file(''),
            { name: 'unreadable.xml', size: 1, arrayBuffer: async () => { throw new Error('Lesefehler'); } }
        ]) {
            const before = app.api.revision();
            await app.upload(invalid);
            assert.equal(app.state().rdfXml, xml);
            assert.equal(app.state().documentIri, 'https://example.org/original.rdf');
            assert.equal(app.api.revision(), before);
            assert.equal(app.get('rdfSourceStatus').classList.contains('alert-danger'), true);
        }
        await app.upload(file('<new/>'));
        assert.equal(app.state().rdfXml, '<new/>');
        assert.equal(app.state().documentIri, null);
    });

    test('an older file read cannot overwrite a newer edit or replacement', async t => {
        const app = harness(t);
        const pending = deferred();
        const old = { name: 'old.xml', size: 8, arrayBuffer: () => pending.promise };
        await app.upload(old);
        app.input('rdfXmlInput', '<newer/>');
        pending.resolve(await file('<old/>').arrayBuffer());
        await settled();
        assert.equal(app.state().rdfXml, '<newer/>');
    });

    test('DDB loading keeps current content until success and sends only the source options', async t => {
        const pending = deferred();
        const app = harness(t, { fetch: () => pending.promise });
        app.api.set({ rdfXml: '<current/>', documentIri: 'https://example.org/current.rdf' });
        app.input('ddbUri', 'https://ddb.example/item');
        app.get('europeanaProfile').checked = true;
        app.get('loadDdbBtn').click();
        app.get('loadDdbBtn').click();
        assert.equal(app.calls.length, 1);
        assert.equal(app.calls[0].url, './api/source');
        assert.equal(app.calls[0].method, 'POST');
        assert.deepEqual(JSON.parse(app.calls[0].body), { ddbUri: 'https://ddb.example/item', europeanaProfile: true });
        assert.equal(app.state().rdfXml, '<current/>');
        assert.equal(app.get('loadDdbBtn').disabled, true);
        pending.resolve(response({ rdfXml: xml, ddbUri: 'https://ddb.example/item', apiUrl: 'https://api.example/document.rdf' }));
        await settled();
        assert.equal(app.state().rdfXml, xml);
        assert.equal(app.state().documentIri, 'https://api.example/document.rdf');
        assert.equal(app.get('loadDdbBtn').disabled, false);
        assert.equal(app.timers.size, 0);
    });

    test('DDB failures preserve source content and render untrusted messages as text', async t => {
        const message = '<img src=x onerror=alert(1)>';
        const app = harness(t, { fetch: async () => response({ error: message }, false) });
        app.api.set({ rdfXml: '<current/>', documentIri: 'https://example.org/current.rdf' });
        app.input('ddbUri', 'https://ddb.example/item');
        app.get('loadDdbBtn').click();
        await settled();
        assert.equal(app.state().rdfXml, '<current/>');
        assert.equal(app.state().documentIri, 'https://example.org/current.rdf');
        assert.equal(app.get('rdfSourceStatus').textContent, message);
        assert.equal(app.get('rdfSourceStatus').querySelector('img'), null);
        assert.equal(app.get('loadDdbBtn').disabled, false);
        assert.equal(app.timers.size, 0);
    });
    test('a refused application connection explains the local failure, preserves XML and permits retry', async t => {
        let attempts = 0;
        const app = harness(t, { fetch: async () => {
            if (++attempts === 1) throw new TypeError('Failed to fetch');
            return response({ rdfXml: xml, apiUrl: 'https://api.example/source.rdf' });
        }});
        app.api.set({ rdfXml: '<current/>' });
        app.input('ddbUri', 'https://ddb.example/item');
        app.get('loadDdbBtn').click();
        await settled();
        assert.match(app.get('rdfSourceStatus').textContent, /Keine Verbindung zur Anwendung unter https:\/\/validator\.example/);
        assert.match(app.get('rdfSourceStatus').textContent, /prüfen, ob die Anwendung läuft/);
        assert.equal(app.state().rdfXml, '<current/>');
        assert.equal(app.get('loadDdbBtn').disabled, false);
        assert.equal(app.timers.size, 0);
        app.get('loadDdbBtn').click();
        await settled();
        assert.equal(app.state().rdfXml, xml);
        assert.equal(attempts, 2);
    });

    test('late DDB responses cannot overwrite edits, uploads, clear actions or programmatic replacements', async t => {
        for (const action of ['edit', 'upload', 'clear', 'set']) {
            const pending = deferred();
            const app = harness(t, { fetch: () => pending.promise });
            app.api.set({ rdfXml: '<current/>' });
            app.input('ddbUri', 'https://ddb.example/item');
            app.get('loadDdbBtn').click();
            if (action === 'edit') app.input('rdfXmlInput', '<edited/>');
            else if (action === 'upload') await app.upload(file('<uploaded/>'));
            else if (action === 'clear') app.get('clearRdfBtn').click();
            else app.api.set({ rdfXml: '<replacement/>' });
            const current = app.state();
            pending.resolve(response({ rdfXml: '<late/>', apiUrl: 'https://example.org/late.rdf' }));
            await settled();
            assert.deepEqual(app.state(), current, action);
            assert.equal(app.calls[0].signal.aborted, true, action);
            assert.equal(app.get('loadDdbBtn').disabled, false, action);
            app.window.dispatchEvent(new app.window.Event('pagehide'));
            assert.equal(app.timers.size, 0, action);
        }
    });

    test('a timeout releases the controls even if fetch ignores abort, and its late response stays discarded', async t => {
        const pending = deferred();
        const app = harness(t, { fetch: () => pending.promise });
        app.input('rdfXmlInput', '<current/>');
        app.input('ddbUri', 'https://ddb.example/item');
        app.get('loadDdbBtn').click();
        const [timerId, timeout] = app.timers.entries().next().value;
        app.timers.delete(timerId);
        timeout();
        assert.equal(app.get('loadDdbBtn').disabled, false);
        assert.equal(app.calls[0].signal.aborted, true);
        assert.match(app.get('rdfSourceStatus').textContent, /dauert zu lange/);
        pending.resolve(response({ rdfXml: '<late/>' }));
        await settled();
        assert.equal(app.state().rdfXml, '<current/>');
        assert.equal(app.timers.size, 0);
    });

    test('cross-tab updates synchronize the common source and invalidate tools only for content or base changes', t => {
        const app = harness(t);
        const change = value => app.window.dispatchEvent(new app.window.StorageEvent('storage', {
            key, oldValue: JSON.stringify(app.state()), newValue: JSON.stringify(value)
        }));
        change({ rdfXml: xml, ddbUri: 'https://ddb.example/item', documentIri: 'https://example.org/base.rdf' });
        assert.equal(app.get('rdfXmlInput').value, xml);
        assert.equal(app.get('ddbUri').value, 'https://ddb.example/item');
        const before = app.api.revision();
        change({ ...app.state(), ddbUri: 'https://ddb.example/candidate' });
        assert.equal(app.api.revision(), before);
        assert.equal(app.get('ddbUri').value, 'https://ddb.example/candidate');
        change({ rdfXml: '', ddbUri: '', documentIri: null });
        assert.equal(app.api.revision(), before + 1);
        assert.equal(app.state().rdfXml, '');
    });

    test('cross-tab candidate URI or profile changes do not cancel an ongoing DDB load', async t => {
        const pending = deferred();
        const app = harness(t, { fetch: () => pending.promise });
        app.input('rdfXmlInput', '<current/>');
        app.input('ddbUri', 'https://ddb.example/item');
        app.get('loadDdbBtn').click();
        const before = app.api.revision();
        app.window.dispatchEvent(new app.window.StorageEvent('storage', { key,
            newValue: JSON.stringify({ ...app.state(), ddbUri: 'https://ddb.example/candidate', europeanaProfile: true }) }));
        assert.equal(app.api.revision(), before);
        assert.equal(app.calls[0].signal.aborted, false);
        assert.equal(app.get('loadDdbBtn').disabled, true);
        assert.equal(app.get('europeanaProfile').checked, true);
        pending.resolve(response({ rdfXml: xml, apiUrl: 'https://api.example/document.rdf' }));
        await settled();
        assert.equal(app.state().rdfXml, xml);
        assert.equal(app.state().documentIri, 'https://api.example/document.rdf');
    });

    test('leaving the page aborts pending requests and removes their timeout without losing saved text', t => {
        const app = harness(t, { fetch: () => new Promise(() => {}) });
        app.input('rdfXmlInput', '<current/>');
        app.input('ddbUri', 'https://ddb.example/item');
        app.get('loadDdbBtn').click();
        app.window.dispatchEvent(new app.window.Event('pagehide'));
        assert.equal(app.calls[0].signal.aborted, true);
        assert.equal(app.timers.size, 0);
        assert.equal(app.get('loadDdbBtn').disabled, false);
        assert.equal(JSON.parse(app.storage.getItem(key)).rdfXml, '<current/>');
    });

    test('a 100-keystroke burst batches a 200 kB document into one storage write', t => {
        const writes = [];
        const app = harness(t, { beforeLoad(window) {
            const setItem = window.Storage.prototype.setItem;
            window.Storage.prototype.setItem = function (name, value) {
                if (name === key) writes.push(value.length);
                return setItem.call(this, name, value);
            };
        } });
        const text = '<root>' + 'x'.repeat(200000) + '</root>';
        const start = performance.now();
        for (let index = 0; index < 100; index++) app.input('rdfXmlInput', text + index);
        assert.equal(writes.length, 0, 'typing never serializes the entire document synchronously');
        assert.equal(app.timers.size, 1, 'only the latest draft waits for persistence');
        [...app.timers.values()][0]();
        assert.equal(writes.length, 1);
        assert.equal(JSON.parse(app.storage.getItem(key)).rdfXml, text + 99);
        t.diagnostic('100 edits of ' + text.length + ' characters: 1 storage write (' + writes[0]
            + ' serialized characters), instead of 100; DOM burst and final save took ' + (performance.now() - start).toFixed(1) + ' ms in JSDOM.');
    });

    test('navigation and hiding the page flush pending drafts; another tab cancels an obsolete local save', t => {
        const app = harness(t);
        app.input('rdfXmlInput', '<first/>');
        const link = app.window.document.createElement('a');
        link.href = './query.html';
        link.addEventListener('click', event => event.preventDefault());
        app.window.document.body.append(link);
        link.click();
        assert.equal(JSON.parse(app.storage.getItem(key)).rdfXml, '<first/>');
        assert.equal(app.timers.size, 0);
        app.input('rdfXmlInput', '<second/>');
        Object.defineProperty(app.window.document, 'visibilityState', { configurable: true, value: 'hidden' });
        app.window.document.dispatchEvent(new app.window.Event('visibilitychange'));
        assert.equal(JSON.parse(app.storage.getItem(key)).rdfXml, '<second/>');
        app.input('rdfXmlInput', '<unsaved-local/>');
        const incoming = JSON.stringify({ rdfXml: '<other-tab/>', ddbUri: '', documentIri: null });
        app.storage.setItem(key, incoming);
        app.window.dispatchEvent(new app.window.StorageEvent('storage', { key, newValue: incoming }));
        assert.equal(app.timers.size, 0);
        app.window.dispatchEvent(new app.window.Event('pagehide'));
        assert.equal(app.state().rdfXml, '<other-tab/>');
        assert.equal(app.storage.getItem(key), incoming, 'a delayed old draft cannot overwrite the newer tab');
    });

    test('another tab changing only the URI or profile cannot erase this tab\'s pending XML draft', t => {
        const previous = JSON.stringify({ rdfXml: '<stored/>', ddbUri: '', documentIri: 'https://example.org/source.rdf' });
        const app = harness(t, { seed: { [key]: previous } });
        app.input('rdfXmlInput', '<pending-new-xml/>');
        const revision = app.api.revision();
        const incoming = JSON.stringify({ rdfXml: '<stored/>', ddbUri: 'https://ddb.example/candidate',
            documentIri: 'https://example.org/source.rdf', europeanaProfile: true });
        app.storage.setItem(key, incoming);
        app.window.dispatchEvent(new app.window.StorageEvent('storage', { key, oldValue: previous, newValue: incoming }));
        assert.equal(app.state().rdfXml, '<pending-new-xml/>');
        assert.equal(app.state().ddbUri, 'https://ddb.example/candidate');
        assert.equal(app.api.revision(), revision);
        assert.equal(app.get('europeanaProfile').checked, true);
        assert.equal(app.timers.size, 1, 'the local draft still waits for its scheduled save');
        app.window.dispatchEvent(new app.window.Event('pagehide'));
        const saved = JSON.parse(app.storage.getItem(key));
        assert.equal(saved.rdfXml, '<pending-new-xml/>');
        assert.equal(saved.ddbUri, 'https://ddb.example/candidate');
        assert.equal(saved.europeanaProfile, true);
    });

    test('restored sources start collapsed and manual toggles or reveal never invalidate tool results', async t => {
        const app = harness(t, { seed: { [key]: JSON.stringify({ rdfXml: xml, ddbUri: '', documentIri: null }) } });
        const before = app.api.revision();
        assert.equal(app.get('rdfSourceBody').classList.contains('show'), false);
        assert.equal(app.get('rdfSourceToggle').getAttribute('aria-expanded'), 'false');
        for (let i = 0; i < 4; i++) {
            app.get('rdfSourceToggle').click();
            const expanded = i % 2 === 0;
            assert.equal(app.get('rdfSourceBody').classList.contains('show'), expanded);
            assert.equal(app.get('rdfSourceToggle').getAttribute('aria-expanded'), String(expanded));
            assert.equal(app.get('rdfSourceBody').hidden, !expanded);
        }
        await app.api.reveal();
        assert.equal(app.get('rdfSourceBody').classList.contains('show'), true);
        assert.equal(app.api.revision(), before);
        assert.equal(app.state().rdfXml, xml);
    });

    test('typing stays open while completed replacements, uploads and DDB loads collapse the source', async t => {
        const app = harness(t);
        app.input('rdfXmlInput', '<');
        assert.equal(app.get('rdfSourceBody').classList.contains('show'), true, 'the first keystroke must not close the editor');
        app.input('rdfXmlInput', xml);
        assert.equal(app.get('rdfSourceBody').classList.contains('show'), true);
        app.api.set({ rdfXml: xml });
        assert.equal(app.get('rdfSourceBody').classList.contains('show'), false);
        await app.api.reveal();
        await app.upload(file('<uploaded/>'));
        assert.equal(app.get('rdfSourceBody').classList.contains('show'), false);
        await app.api.reveal();
        app.input('ddbUri', 'https://ddb.example/item');
        app.get('loadDdbBtn').click();
        await settled();
        assert.equal(app.get('rdfSourceBody').classList.contains('show'), false);
        app.get('clearRdfBtn').click();
        await settled();
        assert.equal(app.get('rdfSourceBody').classList.contains('show'), true);
        assert.equal(app.window.document.activeElement, app.get('rdfXmlInput'));
        app.api.set({ rdfXml: '<replacement/>' });
        app.api.set({ rdfXml: '' });
        assert.equal(app.get('rdfSourceBody').classList.contains('show'), true);
    });

    test('source errors and persistence hints stay outside the collapsed editor', async t => {
        const app = harness(t, { fetch: async () => response({ error: 'Abruf fehlgeschlagen' }, false), beforeLoad(window) {
            window.Storage.prototype.setItem = () => { throw new window.DOMException('Full', 'QuotaExceededError'); };
        } });
        app.api.set({ rdfXml: xml });
        assert.equal(app.get('rdfSourceBody').classList.contains('show'), false);
        assert.equal(app.get('rdfSourceBody').contains(app.get('rdfSourceStorageHint')), false);
        assert.equal(app.get('rdfSourceStorageHint').classList.contains('d-none'), false);
        app.input('ddbUri', 'https://ddb.example/item');
        app.get('loadDdbBtn').click();
        await settled();
        assert.equal(app.get('rdfSourceBody').contains(app.get('rdfSourceStatus')), false);
        assert.equal(app.get('rdfSourceStatus').textContent, 'Abruf fehlgeschlagen');
        assert.equal(app.get('rdfSourceBody').classList.contains('show'), false);
    });

    test('real Bootstrap collapse handles repeated toggles and finishes reveal before source focus', {
        skip: !bootstrapScript && 'Download Bootstrap 5.3.3 bundle to target/bootstrap.bundle.min.js for this integration check'
    }, async t => {
        const app = harness(t, { bootstrap: true,
            seed: { [key]: JSON.stringify({ rdfXml: xml, ddbUri: '', documentIri: null }) } });
        const body = app.get('rdfSourceBody');
        assert.equal(body.hidden, false, 'Bootstrap must be able to measure the content for its opening animation');
        const events = [];
        for (const event of ['show.bs.collapse', 'shown.bs.collapse', 'hide.bs.collapse', 'hidden.bs.collapse']) {
            body.addEventListener(event, () => events.push(event));
        }
        const finishTransition = () => body.dispatchEvent(new app.window.Event('transitionend'));
        const before = app.api.revision();
        for (let i = 0; i < 4; i++) {
            app.get('rdfSourceToggle').click();
            assert.equal(body.classList.contains('collapsing'), true);
            finishTransition();
            const expanded = i % 2 === 0;
            assert.equal(body.classList.contains('show'), expanded);
            assert.equal(app.get('rdfSourceToggle').getAttribute('aria-expanded'), String(expanded));
        }
        assert.deepEqual(events, ['show.bs.collapse', 'shown.bs.collapse', 'hide.bs.collapse', 'hidden.bs.collapse',
            'show.bs.collapse', 'shown.bs.collapse', 'hide.bs.collapse', 'hidden.bs.collapse']);
        let revealed = false;
        const reveal = app.api.reveal().then(() => { revealed = true; });
        await settled();
        assert.equal(revealed, false, 'tools wait until the opening animation completes');
        finishTransition();
        await reveal;
        assert.equal(revealed, true);
        assert.equal(body.classList.contains('show'), true);
        assert.equal(app.api.revision(), before);
        app.api.set({ rdfXml: '<updated/>' });
        assert.equal(body.classList.contains('collapsing'), true);
        app.get('clearRdfBtn').click();
        finishTransition(); // Finish closing; the queued open now starts.
        assert.equal(body.classList.contains('collapsing'), true);
        finishTransition();
        await settled();
        assert.equal(body.classList.contains('show'), true);
        assert.equal(app.window.document.activeElement, app.get('rdfXmlInput'));
    });
}
