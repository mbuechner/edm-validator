const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {Worker} = require('node:worker_threads');
const root = path.resolve(__dirname, '../../..');
const assets = path.join(root, 'src/main/resources/static');
const engineModule = import(pathToFileURL(path.join(assets, 'sparql-engine.mjs')).href);
const workerModule = import(pathToFileURL(path.join(assets, 'sparql-worker.mjs')).href);
const runtime = import(pathToFileURL(path.join(assets, 'vendor/oxigraph-0.5.13/oxigraph.mjs')).href).then(oxigraph => {
    oxigraph.initSync({module: fs.readFileSync(path.join(assets, 'vendor/oxigraph-0.5.13/web_bg.wasm'))});
    return oxigraph;
});
const rdf = value => `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:e="urn:example:">
  <rdf:Description rdf:about="record"><e:name>${value}</e:name></rdf:Description>
</rdf:RDF>`;
const source = {rdfXml: rdf('München &amp; Straße'), baseIri: 'https://example.org/a/'};
const select = 'SELECT ?s ?name ?missing WHERE { ?s <urn:example:name> ?name OPTIONAL {?s <urn:missing> ?missing} }';

async function trackedEngine(overrides = {}) {
    const oxigraph = await runtime;
    const {createSparqlEngine} = await engineModule;
    const counts = {initializations: 0, stores: 0, loads: 0, queries: 0, frees: 0, loadOptions: []};
    class Store extends oxigraph.Store {
        constructor() { super(); counts.stores++; }
        load(text, options) { counts.loads++; counts.loadOptions.push(options); return super.load(text, options); }
        query(text, options) { counts.queries++; return super.query(text, options); }
        free() { counts.frees++; super.free(); }
    }
    let tick = 0;
    const initialize = async () => { counts.initializations++; return {...oxigraph, Store}; };
    const engine = createSparqlEngine({initialize, now: () => ++tick, ...overrides});
    return {engine, counts, initialize};
}

test('real WASM keeps every projected variable, lexical value and prototype-like column', async t => {
    const app = await trackedEngine();
    t.after(() => app.engine.dispose());
    const phases = [];
    const result = await app.engine.query({...source, query: select, onStatus: phase => phases.push(phase)});
    assert.equal(result.kind, 'select');
    assert.deepEqual(result.variables, ['s', 'name', 'missing']);
    assert.deepEqual(JSON.parse(result.json), [{s: 'https://example.org/a/record', name: 'München & Straße', missing: ''}]);
    assert.equal(result.rowCount, 1);
    assert.equal(result.tripleCount, 1);
    assert.deepEqual(phases, ['initializing', 'loading', 'querying']);
    assert.deepEqual(result.timings, {initMs: 1, loadMs: 1, queryMs: 1, serializeMs: 1, cacheHit: false});
    const edgeNames = await app.engine.query({...source, query: 'SELECT ?__proto__ ?constructor ?s WHERE {?s ?p ?o}'});
    const row = JSON.parse(edgeNames.json)[0];
    assert.deepEqual(Object.keys(row), ['__proto__', 'constructor', 's']);
    assert.equal(row.__proto__, '');
    assert.equal(row.constructor, '');
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.equal(app.counts.queries, 2, 'one native query supplies variables and values without a second metadata query');
    const mixed = {baseIri: source.baseIri, rdfXml: `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:e="urn:example:">
      <rdf:Description rdf:about="urn:record"><e:number rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">42</e:number>
        <e:greeting xml:lang="de">Hallo</e:greeting><e:child rdf:nodeID="child"/></rdf:Description></rdf:RDF>`};
    const scalar = await app.engine.query({...mixed, query: `SELECT ?s ?number ?greeting ?child ?absent WHERE {
      ?s <urn:example:number> ?number; <urn:example:greeting> ?greeting; <urn:example:child> ?child.
      OPTIONAL {?s <urn:missing> ?absent} }`});
    const values = JSON.parse(scalar.json)[0];
    assert.equal(values.s, 'urn:record');
    assert.equal(values.number, '42');
    assert.equal(values.greeting, 'Hallo');
    assert.equal(values.absent, '');
    assert.ok(values.child.length > 0);
    assert.ok(Object.values(values).every(value => typeof value === 'string'));
    const count = await app.engine.query({...mixed, query: 'SELECT (COUNT(*) AS ?count) WHERE {?s ?p ?o}'});
    assert.deepEqual(JSON.parse(count.json), [{count: '3'}]);
});

test('the exact XML and base are cached independently of query text and old stores are freed', async () => {
    const app = await trackedEngine();
    const first = await app.engine.query({...source, query: select});
    const repeated = await app.engine.query({...source, query: 'ASK {?s ?p ?o}'});
    assert.equal(first.timings.cacheHit, false);
    assert.equal(repeated.timings.cacheHit, true);
    assert.deepEqual(repeated.timings, {initMs: 0, loadMs: 0, queryMs: 1, serializeMs: 1, cacheHit: true});
    assert.equal(app.counts.loads, 1);
    const moved = await app.engine.query({...source, baseIri: 'https://example.org/b/', query: select});
    assert.equal(JSON.parse(moved.json)[0].s, 'https://example.org/b/record');
    assert.equal(moved.timings.cacheHit, false);
    const edited = await app.engine.query({...source, rdfXml: source.rdfXml + '\n', query: select});
    assert.equal(edited.timings.cacheHit, false, 'even a whitespace-only source change invalidates the exact source cache');
    assert.equal(app.counts.initializations, 1);
    assert.equal(app.counts.loads, 3);
    assert.equal(app.counts.frees, 2);
    for (const options of app.counts.loadOptions) {
        assert.equal(options.format, 'application/rdf+xml');
        assert.equal(options.no_transaction, undefined);
        assert.equal(options.unchecked, undefined);
        assert.equal(options.lenient, undefined);
    }
    app.engine.dispose();
    assert.equal(app.counts.frees, 3);
});

test('document and nested XML bases resolve RDF identifiers while SPARQL uses its own query base', async t => {
    const app = await trackedEngine();
    t.after(() => app.engine.dispose());
    const rdfXml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
        xmlns:e="urn:example:" xml:base="../records/">
      <rdf:Description xml:base="nested/" rdf:about="item">
        <e:view rdf:resource="../view"/>
        <e:image xml:base="../../assets/" rdf:resource="image.jpg"/>
        <e:part><rdf:Description xml:base="../parts/" rdf:about="part">
          <e:link rdf:resource="../shared"/>
        </rdf:Description></e:part>
      </rdf:Description>
    </rdf:RDF>`;
    const query = `PREFIX e: <urn:example:>
      SELECT ?s ?view ?image ?part ?shared ?queryBase WHERE {
        ?s e:view ?view; e:image ?image; e:part ?part.
        ?part e:link ?shared.
        FILTER(?s = <../records/nested/item>)
        FILTER(?view = <../records/view>)
        BIND(IRI("item") AS ?queryBase)
      }`;
    const baseIri = 'https://example.org/source/metadata/source.rdf';
    const first = await app.engine.query({rdfXml, baseIri, query});
    assert.deepEqual(JSON.parse(first.json), [{
        s: 'https://example.org/source/records/nested/item',
        view: 'https://example.org/source/records/view',
        image: 'https://example.org/source/assets/image.jpg',
        part: 'https://example.org/source/records/parts/part',
        shared: 'https://example.org/source/records/shared',
        queryBase: 'https://example.org/source/metadata/item'
    }]);
    assert.equal(first.tripleCount, 4);
    const explicitBase = await app.engine.query({rdfXml, baseIri,
        query: 'BASE <https://query.example/override/> SELECT (IRI("item") AS ?value) WHERE {}'});
    assert.deepEqual(JSON.parse(explicitBase.json), [{value: 'https://query.example/override/item'}]);
    assert.equal(explicitBase.timings.cacheHit, true, 'a SPARQL BASE declaration does not reload the RDF source');
    const changed = await app.engine.query({rdfXml, baseIri: 'https://mirror.example/other/metadata/source.rdf', query});
    assert.deepEqual(JSON.parse(changed.json), [{
        s: 'https://mirror.example/other/records/nested/item',
        view: 'https://mirror.example/other/records/view',
        image: 'https://mirror.example/other/assets/image.jpg',
        part: 'https://mirror.example/other/records/parts/part',
        shared: 'https://mirror.example/other/records/shared',
        queryBase: 'https://mirror.example/other/metadata/item'
    }]);
    assert.equal(changed.timings.cacheHit, false);
    assert.equal(app.counts.loads, 4, 'each base uses one transactional native attempt and one relative xml:base compatibility load');
    assert.equal(app.counts.frees, 1);
});

test('relative XML bases preserve native XML literal values and already-supported DTD inputs stay native', async t => {
    const app = await trackedEngine();
    t.after(() => app.engine.dispose());
    const literal = '<span xmlns="urn:markup" xml:base="../literal/">München &amp; Straße</span>';
    const relative = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:e="urn:example:" xml:base="../records/">
      <rdf:Description rdf:about="item"><e:xml rdf:parseType="Literal">${literal}</e:xml></rdf:Description></rdf:RDF>`;
    const baseIri = 'https://example.org/source/metadata/file.rdf';
    const query = 'SELECT ?value WHERE {?s <urn:example:xml> ?value}';
    const fixed = await app.engine.query({rdfXml: relative, baseIri, query});
    const absolute = await app.engine.query({rdfXml: relative.replace('xml:base="../records/"', 'xml:base="https://example.org/source/records/"'), baseIri, query});
    assert.equal(JSON.parse(fixed.json)[0].value, JSON.parse(absolute.json)[0].value);
    assert.ok(JSON.parse(fixed.json)[0].value.includes('xml:base="../literal/"'));
    assert.equal(app.counts.loads, 3, 'relative input needs compatibility once, absolute input uses its original native load');
    const dtd = `<!DOCTYPE rdf:RDF [<!ENTITY name "Sammlung">]>
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:e="urn:example:" xml:base="https://example.org/">
      <rdf:Description rdf:about="item"><e:name>&name;</e:name></rdf:Description></rdf:RDF>`;
    const original = await app.engine.query({rdfXml: dtd, baseIri, query: 'SELECT ?name WHERE {?s <urn:example:name> ?name}'});
    assert.deepEqual(JSON.parse(original.json), [{name: 'Sammlung'}]);
    assert.equal(app.counts.loads, 4, 'existing DTD support never enters the SAX compatibility path');
});

test('bad replacement data throws a loading error and never queries the previous document', async t => {
    const app = await trackedEngine();
    t.after(() => app.engine.dispose());
    await app.engine.query({...source, query: select});
    const invalid = {rdfXml: rdf('other').replace('</rdf:RDF>', '<broken>'), baseIri: source.baseIri};
    await assert.rejects(app.engine.query({...invalid, query: select}), error => {
        assert.equal(error.phase, 'loading');
        assert.equal(error.timings.queryMs, 0);
        assert.equal(error.timings.cacheHit, false);
        return true;
    });
    assert.equal(app.counts.queries, 1, 'the failed replacement must not run a query on cached old data');
    assert.equal(app.counts.frees, 1, 'the failed candidate store is explicitly released');
    const old = await app.engine.query({...source, query: select});
    assert.equal(old.timings.cacheHit, true);
    assert.equal(JSON.parse(old.json)[0].name, 'München & Straße');
    assert.equal(app.counts.loads, 2);
});

test('query errors preserve loaded data, updates cannot mutate it, ASK and graph queries use native results', async t => {
    const app = await trackedEngine();
    t.after(() => app.engine.dispose());
    await assert.rejects(app.engine.query({...source, query: 'not a query'}), error => error.phase === 'querying');
    await assert.rejects(app.engine.query({...source, query: 'INSERT DATA {<urn:new> <urn:p> <urn:o>}'}), error => error.phase === 'querying');
    const ask = await app.engine.query({...source, query: 'ASK {<urn:new> ?p ?o}'});
    assert.equal(ask.kind, 'ask');
    assert.equal(ask.json, 'false');
    assert.equal(ask.tripleCount, 1);
    const graph = await app.engine.query({...source, query: 'CONSTRUCT {?s ?p ?o} WHERE {?s ?p ?o}'});
    assert.equal(graph.kind, 'graph');
    assert.equal(graph.rowCount, 1);
    assert.equal(JSON.parse(graph.json)[0]['@id'], 'https://example.org/a/record');
    assert.equal(app.counts.loads, 1);
});

test('initialization failure can be retried without caching a failed source', async t => {
    const oxigraph = await runtime;
    const {createSparqlEngine} = await engineModule;
    let attempts = 0;
    const engine = createSparqlEngine({initialize: async () => {
        if (++attempts === 1) throw new Error('WASM unavailable');
        return oxigraph;
    }});
    t.after(() => engine.dispose());
    await assert.rejects(engine.query({...source, query: select}), error => error.phase === 'initializing');
    const retry = await engine.query({...source, query: select});
    assert.equal(retry.rowCount, 1);
    assert.equal(retry.timings.cacheHit, false);
    assert.equal(attempts, 2);
});

test('worker core returns phase-tagged messages and never accepts unknown or failed source IDs', async t => {
    const app = await trackedEngine();
    const {createSparqlWorkerHandler} = await workerModule;
    const messages = [];
    const handler = createSparqlWorkerHandler({engine: app.engine, postMessage: message => messages.push(message), schedule: queueMicrotask});
    t.after(() => handler.dispose());
    const missing = await handler.handleMessage({type: 'query', requestId: 1, sourceId: 'missing', query: select});
    assert.equal(missing.type, 'error');
    assert.equal(missing.phase, 'loading');
    assert.equal(app.counts.initializations, 0);
    const first = await handler.handleMessage({type: 'query', requestId: 2, sourceId: 'valid', source, query: select});
    assert.equal(first.type, 'result');
    assert.equal(first.requestId, 2);
    assert.equal(first.sourceId, 'valid');
    assert.deepEqual(messages.filter(message => message.type === 'status').map(message => message.phase), ['initializing', 'loading', 'querying']);
    const syntax = await handler.handleMessage({type: 'query', requestId: 3, sourceId: 'valid', query: 'invalid query'});
    assert.equal(syntax.phase, 'querying');
    const afterSyntax = await handler.handleMessage({type: 'query', requestId: 4, sourceId: 'valid', query: select});
    assert.equal(afterSyntax.timings.cacheHit, true);
    const bad = await handler.handleMessage({type: 'query', requestId: 5, sourceId: 'bad', source: {...source, rdfXml: '<broken>'}, query: select});
    assert.equal(bad.phase, 'loading');
    const noSource = await handler.handleMessage({type: 'query', requestId: 6, sourceId: 'bad', query: select});
    assert.equal(noSource.phase, 'loading');
    assert.equal(app.counts.loads, 2, 'unknown source retries do not implicitly query or reparse old data');
    const back = await handler.handleMessage({type: 'query', requestId: 7, sourceId: 'valid', query: select});
    assert.equal(back.timings.cacheHit, true);
    assert.equal(JSON.parse(back.json)[0].name, 'München & Straße');
});

test('worker coalesces waiting queries without losing a pending source payload or unresolved reply', async t => {
    const oxigraph = await runtime;
    const {createSparqlEngine} = await engineModule;
    const {createSparqlWorkerHandler} = await workerModule;
    let releaseInitialization;
    const gate = new Promise(resolve => { releaseInitialization = resolve; });
    let loads = 0;
    class Store extends oxigraph.Store {
        load(text, options) { loads++; return super.load(text, options); }
    }
    const engine = createSparqlEngine({initialize: async () => { await gate; return {...oxigraph, Store}; }});
    const messages = [];
    const handler = createSparqlWorkerHandler({engine, postMessage: message => messages.push(message), schedule: queueMicrotask});
    t.after(() => handler.dispose());
    const first = handler.handleMessage({type: 'query', requestId: 1, sourceId: 'a', source, query: select});
    const superseded = handler.handleMessage({type: 'query', requestId: 2, sourceId: 'b', source: {...source, rdfXml: rdf('New')}, query: select});
    const latest = handler.handleMessage({type: 'query', requestId: 3, sourceId: 'b', query: select});
    assert.equal((await superseded).cancelled, true);
    releaseInitialization();
    assert.equal((await first).type, 'result');
    const result = await latest;
    assert.equal(result.requestId, 3);
    assert.equal(JSON.parse(result.json)[0].name, 'New');
    assert.equal(loads, 2, 'only the first and latest pending queries load their documents');
    assert.equal(messages.filter(message => message.type === 'result').length, 2);
});

test('the actual worker entry point queries real WASM in a separate worker thread and reuses its store', async t => {
    const workerUrl = pathToFileURL(path.join(assets, 'sparql-worker.mjs')).href;
    const moduleUrl = pathToFileURL(path.join(assets, 'vendor/oxigraph-0.5.13/oxigraph.mjs')).href;
    const wasmPath = path.join(assets, 'vendor/oxigraph-0.5.13/web_bg.wasm');
    // Adapt only the browser messaging surface and preload bytes; the production entry point runs unchanged.
    const worker = new Worker(`
        const {parentPort} = require('node:worker_threads');
        const fs = require('node:fs');
        (async () => {
            const oxigraph = await import(${JSON.stringify(moduleUrl)});
            oxigraph.initSync({module: fs.readFileSync(${JSON.stringify(wasmPath)})});
            global.self = {
                postMessage: message => parentPort.postMessage(message),
                addEventListener: (_type, callback) => parentPort.on('message', data => callback({data}))
            };
            await import(${JSON.stringify(workerUrl)});
            parentPort.postMessage({type: 'ready'});
        })().catch(error => { throw error; });
    `, {eval: true});
    t.after(() => worker.terminate());
    const messages = [];
    worker.on('message', message => messages.push(message));
    function receive(predicate) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => done(new Error('Worker response timed out')), 5_000);
            const listener = message => { if (predicate(message)) done(null, message); };
            const failed = error => done(error);
            function done(error, message) {
                clearTimeout(timer);
                worker.off('message', listener);
                worker.off('error', failed);
                if (error) reject(error); else resolve(message);
            }
            worker.on('message', listener);
            worker.once('error', failed);
        });
    }
    await receive(message => message.type === 'ready');
    const firstReply = receive(message => message.type === 'result' && message.requestId === 1);
    worker.postMessage({type: 'query', requestId: 1, sourceId: 'thread-source', source, query: select});
    const first = await firstReply;
    assert.equal(first.sourceId, 'thread-source');
    assert.equal(first.timings.cacheHit, false);
    assert.equal(JSON.parse(first.json)[0].name, 'München & Straße');
    const secondReply = receive(message => message.type === 'result' && message.requestId === 2);
    worker.postMessage({type: 'query', requestId: 2, sourceId: 'thread-source', query: 'ASK {?s ?p ?o}'});
    const second = await secondReply;
    assert.equal(second.kind, 'ask');
    assert.equal(second.json, 'true');
    assert.equal(second.timings.cacheHit, true);
    assert.equal(second.timings.loadMs, 0);
    assert.equal(messages.filter(message => message.type === 'status' && message.phase === 'loading').length, 1);
});
