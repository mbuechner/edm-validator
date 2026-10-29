import {createSparqlEngine} from './sparql-engine.mjs';

const emptyTimings = () => ({initMs: 0, loadMs: 0, queryMs: 0, serializeMs: 0, cacheHit: false});
const validId = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** One active query and one replaceable pending query keep source copies and queued work bounded. */
export function createSparqlWorkerHandler({engine = createSparqlEngine(), postMessage,
    schedule = callback => setTimeout(callback, 0)} = {}) {
    let active = null;
    let pending = null;
    let knownSource = null;
    let running = false;
    let disposed = false;

    function emit(message) {
        try { postMessage(message); } catch (_) { /* A closed worker client cannot receive a reply. */ }
        return message;
    }

    function failure(message, phase, text, timings = emptyTimings(), cancelled = false) {
        return {type: 'error', requestId: message?.requestId, sourceId: message?.sourceId,
            phase, message: text, timings, ...(cancelled ? {cancelled: true} : {})};
    }

    function supersede(job) {
        job.resolve(emit(failure(job.message, 'querying',
            'Die Abfrage wurde durch eine neuere Anfrage ersetzt.', emptyTimings(), true)));
    }

    async function drain() {
        if (running) return;
        running = true;
        try {
            while (pending && !disposed) {
                active = pending;
                pending = null;
                const job = active;
                const ids = {requestId: job.message.requestId, sourceId: job.message.sourceId};
                let reply;
                try {
                    const result = await engine.query({...job.source, query: job.message.query,
                        onStatus: phase => emit({type: 'status', ...ids, phase})});
                    knownSource = {sourceId: job.message.sourceId, source: job.source};
                    reply = {type: 'result', ...ids, ...result};
                } catch (error) {
                    // A query error still leaves a successfully loaded source ready for another query.
                    if (error.phase === 'querying') knownSource = {sourceId: job.message.sourceId, source: job.source};
                    reply = failure(job.message, error.phase || 'querying', error.message || String(error), error.timings);
                }
                job.resolve(emit(reply));
                active = null;
                // Let newer browser messages arrive before starting queued synchronous WASM work.
                await new Promise(resolve => schedule(resolve));
            }
        } finally {
            running = false;
            if (pending && !disposed) drain();
        }
    }

    function handleMessage(message) {
        if (!message || message.type !== 'query' || !validId(message.requestId) || !validId(message.sourceId)
            || typeof message.query !== 'string') {
            return Promise.resolve(emit(failure(message, 'querying', 'Ungültige SPARQL-Worker-Anfrage.')));
        }
        if (disposed) return Promise.resolve(emit(failure(message, 'querying', 'Der SPARQL-Worker wurde beendet.')));
        let source = message.source;
        if (source === undefined) {
            const remembered = [pending && {sourceId: pending.message.sourceId, source: pending.source},
                active && {sourceId: active.message.sourceId, source: active.source}, knownSource]
                .find(candidate => candidate && candidate.sourceId === message.sourceId);
            source = remembered?.source;
        }
        if (!source || typeof source.rdfXml !== 'string' || (source.baseIri != null && typeof source.baseIri !== 'string')) {
            return Promise.resolve(emit(failure(message, 'loading',
                'Die RDF-Quelle ist nicht im Worker verfügbar. Bitte die Eingabe erneut senden.')));
        }
        source = {rdfXml: source.rdfXml, baseIri: source.baseIri ?? ''};
        if (pending) supersede(pending);
        const result = new Promise(resolve => { pending = {message, source, resolve}; });
        drain();
        return result;
    }

    function dispose() {
        disposed = true;
        if (pending) { supersede(pending); pending = null; }
        knownSource = null;
        engine.dispose();
    }

    return Object.freeze({handleMessage, dispose});
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
    const handler = createSparqlWorkerHandler({postMessage: message => self.postMessage(message)});
    self.addEventListener('message', event => { handler.handleMessage(event.data); });
}
