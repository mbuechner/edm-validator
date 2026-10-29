const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {Worker} = require('node:worker_threads');

const root = path.resolve(__dirname, '../../..');
const workerUrl = pathToFileURL(path.join(root, 'src/main/resources/static/sparql-worker.mjs')).href;
const wasmUrl = pathToFileURL(path.join(root, 'src/main/resources/static/vendor/oxigraph-0.5.13/web_bg.wasm')).href;
const source = title => ({
    rdfXml: `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="urn:example:">
  <rdf:Description rdf:about="record"><ex:title>${title}</ex:title></rdf:Description>
</rdf:RDF>`,
    baseIri: 'https://example.org/source/'
});
const select = 'SELECT ?s ?title ?missing WHERE { ?s <urn:example:title> ?title OPTIONAL {?s <urn:missing> ?missing} }';

async function runtime(t) {
    // Adapt only browser APIs. Importing the real worker creates its default engine,
    // which imports Oxigraph and fetches/initializes the actual WASM through its normal path.
    const worker = new Worker(`
        const {parentPort, workerData} = require('node:worker_threads');
        const {readFile} = require('node:fs/promises');
        globalThis.self = {
            postMessage: message => parentPort.postMessage(message),
            addEventListener: (type, callback) => {
                if (type === 'message') parentPort.on('message', data => callback({data}));
            }
        };
        globalThis.fetch = async input => {
            const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
            if (url.href !== workerData.wasmUrl) throw new Error('Unexpected worker fetch: ' + url.href);
            const bytes = await readFile(url);
            parentPort.postMessage({type: 'adapter-fetch', url: url.href, mime: 'application/wasm', size: bytes.length});
            return new Response(bytes, {status: 200, headers: {'Content-Type': 'application/wasm'}});
        };
        import(workerData.workerUrl).then(() => parentPort.postMessage({type: 'adapter-ready'}))
            .catch(error => { setImmediate(() => { throw error; }); });
    `, {eval: true, workerData: {workerUrl, wasmUrl}});
    const messages = [];
    const waiting = new Set();
    let failure = null;
    worker.on('message', message => {
        messages.push(message);
        for (const waiter of [...waiting]) if (waiter.predicate(message)) waiter.complete(null, message);
    });
    worker.on('error', error => {
        failure = error;
        for (const waiter of [...waiting]) waiter.complete(error);
    });
    worker.on('exit', code => {
        if (waiting.size) {
            const error = failure || new Error('Worker exited before its response: ' + code);
            for (const waiter of [...waiting]) waiter.complete(error);
        }
    });
    t.after(async () => {
        for (const waiter of [...waiting]) waiter.complete(new Error('Worker test finished'));
        await worker.terminate();
    });

    function receive(predicate) {
        if (failure) return Promise.reject(failure);
        const existing = messages.find(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const waiter = {predicate, complete(error, message) {
                clearTimeout(timer);
                waiting.delete(waiter);
                if (error) reject(error); else resolve(message);
            }};
            const timer = setTimeout(() => waiter.complete(new Error('Actual worker response timed out')), 10_000);
            waiting.add(waiter);
        });
    }

    async function query(message) {
        const reply = receive(value => ['result', 'error'].includes(value.type) && value.requestId === message.requestId);
        worker.postMessage({type: 'query', ...message});
        return reply;
    }

    await receive(message => message.type === 'adapter-ready');
    return {messages, query};
}

function phases(app, requestId) {
    return app.messages.filter(message => message.type === 'status' && message.requestId === requestId)
        .map(message => message.phase);
}

function assertIds(app, requestId, sourceId) {
    const relevant = app.messages.filter(message => ['status', 'result', 'error'].includes(message.type)
        && message.requestId === requestId);
    assert.ok(relevant.length > 0);
    relevant.forEach(message => assert.equal(message.sourceId, sourceId));
}

test('the real module worker initializes WASM itself, caches query-only requests and loads changed data', async t => {
    const app = await runtime(t);
    const first = await app.query({requestId: 0, sourceId: 'source-a', source: source('München &amp; Straße'), query: select});
    assert.equal(first.type, 'result');
    assert.equal(first.kind, 'select');
    assert.equal(first.timings.cacheHit, false);
    assert.equal(first.tripleCount, 1);
    assert.deepEqual(first.variables, ['s', 'title', 'missing']);
    assert.deepEqual(JSON.parse(first.json), [{s: 'https://example.org/source/record', title: 'München & Straße', missing: ''}]);
    assert.deepEqual(phases(app, 0), ['initializing', 'loading', 'querying']);
    assertIds(app, 0, 'source-a');

    const cached = await app.query({requestId: 'query-only', sourceId: 'source-a', query: 'ASK {?s ?p ?o}'});
    assert.equal(cached.type, 'result');
    assert.equal(cached.kind, 'ask');
    assert.equal(cached.json, 'true');
    assert.equal(cached.timings.cacheHit, true);
    assert.equal(cached.timings.initMs, 0);
    assert.equal(cached.timings.loadMs, 0);
    assert.deepEqual(phases(app, 'query-only'), ['querying']);
    assertIds(app, 'query-only', 'source-a');

    const changed = await app.query({requestId: 2, sourceId: 'source-b', source: source('Berlin'), query: select});
    assert.equal(changed.type, 'result');
    assert.equal(changed.timings.cacheHit, false);
    assert.deepEqual(JSON.parse(changed.json), [{s: 'https://example.org/source/record', title: 'Berlin', missing: ''}]);
    assert.deepEqual(phases(app, 2), ['loading', 'querying']);
    assertIds(app, 2, 'source-b');
    const fetches = app.messages.filter(message => message.type === 'adapter-fetch');
    assert.equal(fetches.length, 1, 'the default initializer loads WASM exactly once for this worker');
    assert.equal(fetches[0].url, wasmUrl);
    assert.equal(fetches[0].mime, 'application/wasm');
    assert.ok(fetches[0].size > 0);
    for (const result of [first, cached, changed]) {
        for (const field of ['initMs', 'loadMs', 'queryMs', 'serializeMs']) {
            assert.ok(Number.isFinite(result.timings[field]) && result.timings[field] >= 0, field);
        }
    }
});

test('real worker load and query errors retain their IDs and recover without returning stale replacement data', async t => {
    const app = await runtime(t);
    const unknown = await app.query({requestId: 'unknown', sourceId: 99, query: select});
    assert.equal(unknown.type, 'error');
    assert.equal(unknown.phase, 'loading');
    assertIds(app, 'unknown', 99);
    assert.equal(app.messages.filter(message => message.type === 'adapter-fetch').length, 0);

    const first = await app.query({requestId: 'first', sourceId: 1, source: source('Original'), query: select});
    assert.equal(first.type, 'result');
    const bad = await app.query({requestId: 'bad-source', sourceId: 2,
        source: {...source('Replacement'), rdfXml: '<broken>'}, query: select});
    assert.equal(bad.type, 'error');
    assert.equal(bad.phase, 'loading');
    assert.equal(bad.timings.queryMs, 0);
    assertIds(app, 'bad-source', 2);
    assert.ok(!app.messages.some(message => message.type === 'result' && message.requestId === 'bad-source'));

    const missing = await app.query({requestId: 'missing-source', sourceId: 2, query: select});
    assert.equal(missing.type, 'error');
    assert.equal(missing.phase, 'loading');
    assertIds(app, 'missing-source', 2);
    const invalidQuery = await app.query({requestId: 'syntax-error', sourceId: 1, query: 'this is not SPARQL'});
    assert.equal(invalidQuery.type, 'error');
    assert.equal(invalidQuery.phase, 'querying');
    assert.equal(invalidQuery.timings.cacheHit, true);
    assert.equal(invalidQuery.timings.loadMs, 0);
    assertIds(app, 'syntax-error', 1);

    const recovered = await app.query({requestId: 'recovered', sourceId: 1, query: select});
    assert.equal(recovered.type, 'result');
    assert.equal(recovered.timings.cacheHit, true);
    assert.equal(JSON.parse(recovered.json)[0].title, 'Original');
    assertIds(app, 'recovered', 1);
    assert.equal(app.messages.filter(message => message.type === 'adapter-fetch').length, 1);
});

test('the supplied museum portal query reuses the real worker store for 100 queries and reports separate timings', async t => {
    const app = await runtime(t);
    const rdfXml = fs.readFileSync(path.join(root, 'src/test/resources/query/224IOLKFSF3WLN3FUEHIBGIVX3PRYU6I.rdf.xml'), 'utf8');
    const query = fs.readFileSync(path.join(root, 'src/main/resources/static/queries/portal-select.rq'), 'utf8');
    const sourceId = 'museum';
    const samples = [];
    for (let i = 0; i < 100; i++) {
        const result = await app.query({requestId: i, sourceId, query: query + '\n# query-only change ' + i,
            ...(i === 0 ? {source: {rdfXml, baseIri: 'https://validator.example/query.html'}} : {})});
        assert.equal(result.type, 'result');
        assert.equal(result.rowCount, 1);
        const [row] = JSON.parse(result.json);
        assert.equal(Object.keys(row).length, 20);
        assert.equal(row.titel, 'Tanzendes Bauernpaar');
        assert.equal(result.timings.cacheHit, i > 0);
        if (i > 0) assert.equal(result.timings.loadMs, 0);
        samples.push(result.timings);
    }
    assert.equal(app.messages.filter(message => message.type === 'status' && message.phase === 'loading').length, 1);
    assert.equal(app.messages.filter(message => message.type === 'adapter-fetch').length, 1);
    const changed = await app.query({requestId: 'museum-changed', sourceId: 'changed', query,
        source: {rdfXml: rdfXml.replace('Tanzendes Bauernpaar', 'Geänderter Titel'), baseIri: 'https://validator.example/query.html'}});
    assert.equal(JSON.parse(changed.json)[0].titel, 'Geänderter Titel');
    assert.equal(changed.timings.cacheHit, false);
    assert.equal(app.messages.filter(message => message.type === 'status' && message.phase === 'loading').length, 2);
    const queryTimes = samples.slice(1).map(sample => sample.queryMs).sort((a, b) => a - b);
    t.diagnostic(JSON.stringify({fixture: 'corrected supplied museum record', triples: 115,
        sourceBytes: Buffer.byteLength(rdfXml), first: samples[0],
        repeatedQueryMedianMs: queryTimes[Math.floor(queryTimes.length / 2)],
        queries: 100, rdfLoads: 1, wasmFetches: 1, afterSourceChange: changed.timings}));
});
