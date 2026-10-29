const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.resolve(__dirname, '../../main/resources/static/sparql-client.js'), 'utf8');
const source = { rdfXml: '<rdf:RDF/>', baseIri: 'https://example.org/source.rdf' };
const plain = value => JSON.parse(JSON.stringify(value));

class FakeWorker {
    constructor() { this.messages = []; this.terminated = 0; }
    postMessage(message) {
        if (this.postError) throw this.postError;
        this.messages.push(plain(message));
    }
    terminate() { this.terminated++; }
    emit(data) { this.onmessage?.({ data }); }
    reply(message = this.messages.at(-1), fields = {}) {
        const result = { type: 'result', requestId: message.requestId, sourceId: message.sourceId,
            kind: 'select', json: '{"results":{"bindings":[]}}', rowCount: 0, variables: [], timings: {}, tripleCount: 1, ...fields };
        this.emit(result);
        return result;
    }
    error(phase, message = this.messages.at(-1), fields = {}) {
        this.emit({ type: 'error', requestId: message.requestId, sourceId: message.sourceId,
            phase, message: 'Worker ' + phase + ' failed', ...fields });
    }
}

function harness(options = {}) {
    const workers = [], creations = [], statuses = [], timers = new Map(), listeners = new Map();
    let timerId = 0;
    let now = 0;
    const makeWorker = (url, config) => {
        creations.push({ url: String(url), config: plain(config) });
        if (options.factoryError && creations.length === 1) throw new Error('Worker construction failed');
        const worker = new FakeWorker();
        options.configureWorker?.(worker, workers.length);
        workers.push(worker);
        return worker;
    };
    const window = {
        setTimeout(callback, delay) { timers.set(++timerId, { callback, delay, deadline: now + delay }); return timerId; },
        clearTimeout(id) { timers.delete(id); },
        addEventListener(name, callback) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(callback);
        },
        removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
        Worker: class { constructor(url, config) { return makeWorker(url, config); } }
    };
    vm.runInNewContext(script, { window, document: { baseURI: 'https://validator.example/custom/tools/query.html' }, URL });
    const client = window.SparqlClient.create({ onStatus: status => statuses.push(status),
        ...(options.defaultFactory ? {} : { workerFactory: makeWorker }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
    return { client, window, workers, creations, statuses, timers, listeners,
        fire(name) { for (const callback of listeners.get(name) || []) callback(); },
        advance(milliseconds) {
            now += milliseconds;
            for (const [id, timer] of [...timers]) {
                if (timers.has(id) && timer.deadline <= now) timer.callback();
            }
        } };
}

test('the module worker is lazy, uses the application path and returns the complete result packet', async () => {
    const app = harness({ defaultFactory: true });
    assert.equal(app.workers.length, 0);
    const pending = app.client.query(source, 'SELECT * WHERE { ?s ?p ?o }');
    assert.equal(app.workers.length, 1);
    assert.deepEqual(app.creations[0], { url: 'https://validator.example/custom/tools/sparql-worker.mjs', config: { type: 'module' } });
    const worker = app.workers[0];
    assert.deepEqual(worker.messages[0].source, source);
    assert.equal([...app.timers.values()][0].delay, 60000);
    const packet = worker.reply(undefined, { kind: 'ask', json: '{"boolean":true}', rowCount: 1, timings: { queryMs: 2.5 }, tripleCount: 17 });
    assert.equal(await pending, packet);
    assert.equal(app.timers.size, 0);
    app.client.dispose();
});

test('different queries reuse the worker and source; XML or exact base changes send a new source identity', async () => {
    const app = harness();
    const run = async (value, query) => {
        const pending = app.client.query(value, query);
        const worker = app.workers.at(-1);
        const message = worker.messages.at(-1);
        worker.reply(message);
        await pending;
        return message;
    };
    const first = await run(source, 'SELECT ?s WHERE { ?s ?p ?o }');
    const second = await run({ ...source }, 'ASK { ?s ?p ?o }');
    assert.equal(second.sourceId, first.sourceId);
    assert.ok(second.requestId > first.requestId);
    assert.equal('source' in second, false);
    const xmlChange = await run({ ...source, rdfXml: source.rdfXml + '\n' }, 'ASK {}');
    assert.ok(xmlChange.sourceId > first.sourceId);
    assert.equal(xmlChange.source.rdfXml, source.rdfXml + '\n');
    const baseChange = await run({ rdfXml: source.rdfXml + '\n', baseIri: source.baseIri + '#base' }, 'ASK {}');
    assert.ok(baseChange.sourceId > xmlChange.sourceId);
    assert.equal(baseChange.source.baseIri, source.baseIri + '#base');
    const originalAgain = await run(source, 'ASK {}');
    assert.ok(originalAgain.sourceId > baseChange.sourceId);
    assert.deepEqual(originalAgain.source, source);
    assert.equal(app.workers.length, 1);
    app.client.dispose();
});

test('100 queries transfer a 200 kB XML source only once', async t => {
    const app = harness();
    const value = { ...source, rdfXml: '<root>' + 'x'.repeat(200000) + '</root>' };
    for (let index = 0; index < 100; index++) {
        const pending = app.client.query(value, 'SELECT * WHERE { ?s ?p ?o } LIMIT ' + index);
        app.workers[0].reply();
        await pending;
    }
    const messages = app.workers[0].messages;
    const transfers = messages.filter(message => message.source);
    assert.equal(messages.length, 100);
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].source.rdfXml, value.rdfXml);
    t.diagnostic('100 queries: one ' + value.rdfXml.length + '-character source transfer, instead of 100 transfers.');
    app.client.dispose();
});

test('a newer query aborts the old promise and ignores its replies without terminating the cached worker', async () => {
    const app = harness();
    const first = app.client.query(source, 'old query');
    const oldRejected = assert.rejects(first, { name: 'AbortError' });
    const worker = app.workers[0];
    const oldMessage = worker.messages[0];
    const second = app.client.query(source, 'new query');
    let settled = false;
    second.then(() => { settled = true; });
    await oldRejected;
    worker.emit({ type: 'status', requestId: oldMessage.requestId, sourceId: oldMessage.sourceId, phase: 'loading' });
    worker.reply(oldMessage);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(app.statuses.length, 0);
    assert.equal(worker.terminated, 0);
    assert.equal(app.timers.size, 1);
    assert.equal('source' in worker.messages[1], false);
    worker.reply();
    await second;
    app.client.dispose();
});

test('only matching request and source identities can publish status, result or query errors', async () => {
    const app = harness();
    const pending = app.client.query(source, 'query');
    const worker = app.workers[0];
    const message = worker.messages[0];
    for (const ids of [{ requestId: message.requestId + 1, sourceId: message.sourceId },
        { requestId: message.requestId, sourceId: message.sourceId + 1 }]) {
        worker.emit({ type: 'status', ...ids, phase: 'querying' });
        worker.emit({ type: 'result', ...ids });
        worker.emit({ type: 'error', ...ids, phase: 'querying', message: 'Stale failure' });
    }
    worker.emit(null);
    assert.equal(app.statuses.length, 0);
    const status = { type: 'status', requestId: message.requestId, sourceId: message.sourceId, phase: 'querying', tripleCount: 14 };
    worker.emit(status);
    assert.equal(app.statuses[0], status);
    assert.equal(app.timers.size, 1);
    worker.reply();
    await pending;
    app.client.dispose();
});

test('invalidating a request retains the worker and its source for a later query', async () => {
    const app = harness();
    const first = app.client.query(source, 'query');
    const rejected = assert.rejects(first, { name: 'AbortError' });
    const original = app.workers[0].messages[0];
    app.client.invalidate();
    await rejected;
    assert.equal(app.timers.size, 1, 'the abandoned worker job still has its original deadline');
    assert.equal(app.workers[0].terminated, 0);
    const next = app.client.query(source, 'another query');
    assert.equal('source' in app.workers[0].messages[1], false);
    app.workers[0].reply(original);
    assert.equal(app.timers.size, 1, 'an old final response clears only its own watchdog');
    app.workers[0].reply();
    await next;
    app.client.dispose();
});

test('an abandoned job is terminated at its original deadline even without another query', async () => {
    const app = harness({ timeoutMs: 60 });
    const pending = app.client.query(source, 'expensive query');
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    app.advance(20);
    app.client.invalidate();
    await rejected;
    app.advance(39);
    assert.equal(app.workers[0].terminated, 0);
    app.advance(1);
    assert.equal(app.workers[0].terminated, 1);
    assert.equal(app.timers.size, 0);
    const retry = app.client.query(source, 'retry');
    assert.deepEqual(app.workers[1].messages[0].source, source);
    app.workers[1].reply();
    await retry;
    app.client.dispose();
});

test('new queries cannot extend an abandoned job\'s deadline and receive a clear timeout explanation', async () => {
    const app = harness({ timeoutMs: 60 });
    const first = app.client.query(source, 'expensive first query');
    const rejected = assert.rejects(first, { name: 'AbortError' });
    app.advance(40);
    const nextSource = { ...source, rdfXml: '<replacement/>' };
    const next = app.client.query(nextSource, 'new query waiting for the worker');
    await rejected;
    const timeout = assert.rejects(next, error => error.name === 'TimeoutError'
        && /vorherige SPARQL-Abfrage/.test(error.message) && /aktuelle Abfrage abgebrochen/.test(error.message));
    app.advance(20); // The first request expires at 60, before the newer request's deadline of 100.
    await timeout;
    assert.equal(app.workers[0].terminated, 1);
    assert.equal(app.timers.size, 0);
    const retry = app.client.query(nextSource, 'retry current query');
    assert.deepEqual(app.workers[1].messages[0].source, nextSource);
    app.workers[1].reply();
    await retry;
    app.client.dispose();
});

test('an old final reply retires its watchdog without timing out or settling its successor', async () => {
    const app = harness({ timeoutMs: 60 });
    const first = app.client.query(source, 'first');
    const rejected = assert.rejects(first, { name: 'AbortError' });
    const original = app.workers[0].messages[0];
    app.advance(40);
    const next = app.client.query(source, 'successor');
    await rejected;
    app.workers[0].reply(original);
    app.advance(20);
    assert.equal(app.workers[0].terminated, 0);
    assert.equal(app.timers.size, 1);
    app.workers[0].reply();
    await next;
    assert.equal(app.timers.size, 0);
    app.client.dispose();
});

test('load errors resend the source on retry while query errors retain the cached store', async () => {
    const app = harness();
    const first = app.client.query(source, 'query');
    const worker = app.workers[0];
    worker.error('loading', undefined, { message: 'Invalid XML', timings: { loadMs: 7 } });
    await assert.rejects(first, error => error.message === 'Invalid XML' && error.phase === 'loading' && error.timings.loadMs === 7);
    const retry = app.client.query(source, 'retry');
    assert.deepEqual(worker.messages[1].source, source);
    assert.equal(worker.messages[1].sourceId, worker.messages[0].sourceId);
    worker.reply();
    await retry;
    const invalidQuery = app.client.query(source, 'bad query');
    worker.error('querying', undefined, { timings: { queryMs: 3 } });
    await assert.rejects(invalidQuery, error => error.phase === 'querying' && error.timings.queryMs === 3);
    const corrected = app.client.query(source, 'corrected query');
    assert.equal('source' in worker.messages.at(-1), false);
    assert.equal(worker.terminated, 0);
    worker.reply();
    await corrected;
    app.client.dispose();
});

test('an abandoned load failure invalidates only its own source cache', async () => {
    const app = harness();
    const first = app.client.query(source, 'query');
    const rejected = assert.rejects(first, { name: 'AbortError' });
    const worker = app.workers[0];
    const old = worker.messages[0];
    app.client.invalidate();
    await rejected;
    worker.error('loading', old);
    const retry = app.client.query(source, 'retry');
    assert.deepEqual(worker.messages.at(-1).source, source);
    const rejectedRetry = assert.rejects(retry, { name: 'AbortError' });
    const newSource = { ...source, rdfXml: '<other/>' };
    const next = app.client.query(newSource, 'new source');
    await rejectedRetry;
    worker.error('loading', old);
    worker.reply();
    await next;
    const again = app.client.query(newSource, 'same new source');
    assert.equal('source' in worker.messages.at(-1), false, 'a stale failure cannot invalidate the newer store');
    worker.reply();
    await again;
    app.client.dispose();
});

test('an abandoned initialization failure makes an unchanged retry resend its source', async () => {
    const app = harness();
    const first = app.client.query(source, 'first');
    const rejected = assert.rejects(first, { name: 'AbortError' });
    const worker = app.workers[0];
    const original = worker.messages[0];
    app.client.invalidate();
    await rejected;
    worker.error('initializing', original);
    assert.equal(worker.terminated, 0, 'the engine can retry its failed initialization within the same worker');
    assert.equal(app.timers.size, 0);
    const retry = app.client.query(source, 'retry after initialization error');
    assert.deepEqual(worker.messages[1].source, source);
    worker.reply();
    await retry;
    const repeated = app.client.query(source, 'same loaded source');
    assert.equal('source' in worker.messages[2], false);
    worker.reply();
    await repeated;
    app.client.dispose();
});

test('a queued successor can confirm its loaded store after an older initialization failure', async () => {
    for (const outcome of ['result', 'querying']) {
        const app = harness();
        const first = app.client.query(source, 'first');
        const rejected = assert.rejects(first, { name: 'AbortError' });
        const worker = app.workers[0];
        const original = worker.messages[0];
        const next = app.client.query(source, 'queued successor');
        await rejected;
        worker.error('initializing', original);
        if (outcome === 'result') { worker.reply(); await next; }
        else { worker.error('querying'); await assert.rejects(next, error => error.phase === 'querying'); }
        const again = app.client.query(source, 'reuse confirmed store');
        assert.equal('source' in worker.messages.at(-1), false, outcome);
        worker.reply();
        await again;
        app.client.dispose();
    }
});

test('initialization failure, crashes and unreadable replies terminate the worker and permit a lazy retry', async () => {
    for (const failure of ['initializing', 'error', 'messageerror']) {
        const app = harness();
        const pending = app.client.query(source, 'query');
        const oldWorker = app.workers[0];
        const staleHandler = oldWorker.onmessage;
        const oldMessage = oldWorker.messages[0];
        if (failure === 'initializing') oldWorker.error(failure);
        else if (failure === 'error') oldWorker.onerror({ message: 'Worker crashed', preventDefault() {} });
        else oldWorker.onmessageerror({});
        await assert.rejects(pending);
        assert.equal(oldWorker.terminated, 1, failure);
        assert.equal(app.timers.size, 0, failure);
        const retry = app.client.query(source, 'retry');
        const current = app.workers[1];
        assert.deepEqual(current.messages[0].source, source);
        assert.ok(current.messages[0].sourceId > oldMessage.sourceId);
        staleHandler({ data: { ...oldMessage, type: 'result' } });
        assert.equal(app.timers.size, 1, 'terminated worker callbacks cannot settle a newer query');
        current.reply();
        await retry;
        app.client.dispose();
    }
});

test('a timeout clears the request and source cache even when no worker reply arrives', async () => {
    const app = harness({ timeoutMs: 25 });
    const pending = app.client.query(source, 'query');
    const timer = [...app.timers.values()][0];
    assert.equal(timer.delay, 25);
    timer.callback();
    await assert.rejects(pending, { name: 'TimeoutError' });
    assert.equal(app.workers[0].terminated, 1);
    assert.equal(app.timers.size, 0);
    const retry = app.client.query(source, 'retry');
    assert.deepEqual(app.workers[1].messages[0].source, source);
    app.workers[1].reply();
    await retry;
    app.client.dispose();
});

test('worker construction and postMessage failures reject cleanly and can be retried', async () => {
    for (const options of [{ factoryError: true }, { configureWorker(worker, index) {
        if (!index) worker.postError = new Error('Cannot clone message');
    } }]) {
        const app = harness(options);
        await assert.rejects(app.client.query(source, 'query'));
        assert.equal(app.timers.size, 0);
        const retry = app.client.query(source, 'retry');
        const worker = app.workers.at(-1);
        assert.deepEqual(worker.messages[0].source, source);
        worker.reply();
        await retry;
        app.client.dispose();
    }
});

test('pagehide terminates pending work but history restoration can create a fresh worker', async () => {
    const app = harness();
    const pending = app.client.query(source, 'query');
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    app.fire('pagehide');
    await rejected;
    assert.equal(app.workers[0].terminated, 1);
    assert.equal(app.timers.size, 0);
    const resumed = app.client.query(source, 'back from history');
    assert.deepEqual(app.workers[1].messages[0].source, source);
    app.workers[1].reply();
    await resumed;
    app.client.dispose();
    assert.equal(app.listeners.get('pagehide').size, 0);
});

test('explicit disposal is idempotent, rejects active work and prevents creating another worker', async () => {
    const app = harness();
    const pending = app.client.query(source, 'query');
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    app.client.dispose();
    app.client.dispose();
    await rejected;
    assert.equal(app.workers[0].terminated, 1);
    await assert.rejects(app.client.query(source, 'after dispose'), { name: 'InvalidStateError' });
    assert.equal(app.workers.length, 1);
    assert.equal(app.timers.size, 0);
});
