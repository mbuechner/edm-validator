/* Correlated RPC for a reusable SPARQL worker; source text crosses the boundary once. */
(() => {
    'use strict';

    function create({ onStatus, workerFactory, timeoutMs = 60000 } = {}) {
        const makeWorker = workerFactory || ((url, options) => new window.Worker(url, options));
        const limit = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 60000;
        let worker = null;
        let active = null;
        let requestSequence = 0;
        let sourceSequence = 0;
        let sourceKey = null;
        let postedSourceId = null;
        let disposed = false;
        const inFlight = new Map();

        function abortError() {
            const error = new Error('Die SPARQL-Abfrage wurde durch eine neuere Eingabe ersetzt.');
            error.name = 'AbortError';
            return error;
        }

        function settle(error, result) {
            if (!active) return;
            const pending = active;
            active = null;
            if (error) pending.reject(error);
            else pending.resolve(result);
        }

        function finishRequest(requestId, sourceId) {
            const request = inFlight.get(requestId);
            if (!request || request.sourceId !== sourceId) return false;
            window.clearTimeout(request.timeout);
            inFlight.delete(requestId);
            return true;
        }

        function watchRequest(requestId, sourceId) {
            // Editing cancels the UI promise, while synchronous WASM may still run.
            // Keep each posted job's original deadline until its final worker reply.
            const request = { sourceId, timeout: null };
            inFlight.set(requestId, request);
            request.timeout = window.setTimeout(() => {
                if (inFlight.get(requestId) !== request) return;
                const error = new Error(active && active.requestId !== requestId
                    ? 'Eine vorherige SPARQL-Abfrage hat das Zeitlimit überschritten. Daher wurde auch die aktuelle Abfrage abgebrochen. Bitte erneut ausführen.'
                    : 'Die SPARQL-Abfrage hat das Zeitlimit überschritten. Bitte erneut versuchen.');
                error.name = 'TimeoutError';
                reset(error);
            }, limit);
        }

        function reset(error) {
            const previous = worker;
            worker = null;
            sourceKey = null;
            postedSourceId = null;
            for (const request of inFlight.values()) window.clearTimeout(request.timeout);
            inFlight.clear();
            if (previous) {
                previous.onmessage = previous.onerror = previous.onmessageerror = null;
                try { previous.terminate(); } catch (_) { /* Cleanup must still settle the request. */ }
            }
            settle(error);
        }

        function receive(data) {
            if (!data || typeof data !== 'object') return;
            const final = data.type === 'result' || data.type === 'error';
            if (final && !finishRequest(data.requestId, data.sourceId)) return;
            // An abandoned load can still fail. Never treat that source as cached,
            // but never invalidate a different source already posted by a newer query.
            if (data.type === 'error' && ['initializing', 'loading'].includes(data.phase) && data.sourceId === postedSourceId) postedSourceId = null;
            if (data.sourceId === sourceKey?.sourceId && (data.type === 'result'
                || (data.type === 'error' && data.phase === 'querying' && !data.cancelled))) postedSourceId = data.sourceId;
            if (!active || data.requestId !== active.requestId || data.sourceId !== active.sourceId) return;
            if (data.type === 'status') {
                if (typeof onStatus === 'function') onStatus(data);
            } else if (data.type === 'result') settle(null, data);
            else if (data.type === 'error') {
                const error = new Error(data.message || 'Die SPARQL-Abfrage konnte nicht ausgeführt werden.');
                error.phase = data.phase;
                error.timings = data.timings;
                if (data.phase === 'initializing') reset(error);
                else settle(error);
            }
        }

        function ensureWorker() {
            if (worker) return worker;
            const current = makeWorker(new URL('./sparql-worker.mjs', document.baseURI), { type: 'module' });
            worker = current;
            current.onmessage = event => { if (worker === current) receive(event.data); };
            current.onerror = event => {
                if (worker !== current) return;
                event.preventDefault?.();
                reset(new Error(event.message || 'Der SPARQL-Worker ist ausgefallen. Bitte erneut versuchen.'));
            };
            current.onmessageerror = () => {
                if (worker === current) reset(new Error('Die Antwort des SPARQL-Workers konnte nicht gelesen werden.'));
            };
            return current;
        }

        function invalidate() { settle(abortError()); }

        function query(source, queryText) {
            if (disposed) {
                const error = new Error('Der SPARQL-Client wurde bereits beendet.');
                error.name = 'InvalidStateError';
                return Promise.reject(error);
            }
            if (!source || typeof source.rdfXml !== 'string' || typeof queryText !== 'string') {
                return Promise.reject(new TypeError('RDF/XML und SPARQL müssen als Text vorliegen.'));
            }
            invalidate();
            const baseIri = source.baseIri ?? '';
            if (!sourceKey || sourceKey.rdfXml !== source.rdfXml || sourceKey.baseIri !== baseIri) {
                sourceKey = { rdfXml: source.rdfXml, baseIri, sourceId: ++sourceSequence };
            }
            const requestId = ++requestSequence;
            const sourceId = sourceKey.sourceId;
            const message = { type: 'query', requestId, sourceId, query: queryText };
            if (postedSourceId !== sourceId) message.source = { rdfXml: sourceKey.rdfXml, baseIri: sourceKey.baseIri };
            return new Promise((resolve, reject) => {
                const pending = { requestId, sourceId, resolve, reject };
                active = pending;
                try {
                    const current = ensureWorker();
                    watchRequest(requestId, sourceId);
                    postedSourceId = sourceId;
                    current.postMessage(message);
                } catch (error) { reset(error); }
            });
        }

        // A cached page can return from browser history and lazily create a fresh worker.
        const pagehide = () => reset(abortError());
        window.addEventListener('pagehide', pagehide);

        function dispose() {
            disposed = true;
            window.removeEventListener('pagehide', pagehide);
            reset(abortError());
        }

        return Object.freeze({ query, invalidate, dispose });
    }

    window.SparqlClient = Object.freeze({ create });
})();
