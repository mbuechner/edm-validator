/* Oxigraph owns RDF parsing and SPARQL semantics; this module caches one exact source. */
async function initializeOxigraph() {
    const oxigraph = await import('./vendor/oxigraph-0.5.13/oxigraph.mjs');
    await oxigraph.default();
    return oxigraph;
}

const clock = () => performance.now();
const duration = (now, start) => Math.max(0, now() - start);
const release = store => { if (typeof store?.free === 'function') store.free(); };

function resultJson(serialized) {
    const result = JSON.parse(serialized);
    if (Array.isArray(result?.head?.vars) && Array.isArray(result?.results?.bindings)) {
        const variables = result.head.vars;
        const rows = result.results.bindings.map(binding => Object.fromEntries(variables.map(name => [
            name, binding[name]?.value ?? ''
        ])));
        return {kind: 'select', json: JSON.stringify(rows, null, 2), rowCount: rows.length, variables};
    }
    if (typeof result?.boolean === 'boolean') {
        return {kind: 'ask', json: JSON.stringify(result.boolean), rowCount: result.boolean ? 1 : 0, variables: []};
    }
    // Oxigraph serializes CONSTRUCT/DESCRIBE as JSON-LD when results_format is json.
    if (Array.isArray(result)) {
        return {kind: 'graph', json: JSON.stringify(result, null, 2), rowCount: result.length, variables: []};
    }
    throw new Error('Die Abfrage lieferte kein unterstütztes SPARQL-Ergebnis.');
}

/**
 * A source is cached only after a successful strict, transactional RDF/XML load.
 * Query text is never part of the cache key. Parsing a replacement cannot corrupt
 * the previous store, and a failed replacement never falls back to old data.
 * initialize is injectable so Node tests exercise the same engine with real WASM.
 */
export function createSparqlEngine({initialize = initializeOxigraph, now = clock} = {}) {
    let runtime = null;
    let initialization = null;
    let store = null;
    let cachedXml = null;
    let cachedBase = null;
    let disposed = false;

    async function ready() {
        if (runtime) return runtime;
        if (!initialization) initialization = Promise.resolve().then(initialize).then(value => {
            runtime = value;
            return value;
        }).catch(error => {
            initialization = null;
            throw error;
        });
        return initialization;
    }

    async function query({rdfXml, baseIri = '', query: queryText, onStatus = () => {}}) {
        const timings = {initMs: 0, loadMs: 0, queryMs: 0, serializeMs: 0, cacheHit: false};
        let phase = 'loading';
        let measuring = null;
        let started = 0;
        const base = baseIri == null ? '' : baseIri;
        try {
            if (disposed) throw new Error('Die SPARQL-Engine wurde beendet.');
            if (typeof rdfXml !== 'string' || !rdfXml.trim()) throw new Error('Bitte RDF/XML eingeben oder laden.');
            if (typeof base !== 'string') throw new Error('Die Basis-IRI muss eine Zeichenfolge sein.');
            phase = 'initializing';
            if (!runtime) {
                onStatus(phase);
                measuring = 'initMs';
                started = now();
            }
            const oxigraph = await ready();
            if (measuring) timings.initMs = duration(now, started);
            measuring = null;
            if (disposed) throw new Error('Die SPARQL-Engine wurde beendet.');

            timings.cacheHit = store !== null && cachedXml === rdfXml && cachedBase === base;
            if (!timings.cacheHit) {
                phase = 'loading';
                onStatus(phase);
                measuring = 'loadMs';
                started = now();
                const candidate = new oxigraph.Store();
                try {
                    const options = {format: 'application/rdf+xml', ...(base ? {base_iri: base} : {})};
                    try {
                        candidate.load(rdfXml, options);
                    } catch (error) {
                        // Keep native handling (including supported DTDs) unless the known 0.5.13
                        // relative xml:base bug occurs. Failed loads are transactional by default.
                        if (!rdfXml.includes('xml:base') || !error?.message?.includes('No scheme found in an absolute IRI')) throw error;
                        const {resolveRdfXmlBases} = await import('./rdf-xml-base.mjs');
                        const input = resolveRdfXmlBases(rdfXml, base);
                        if (input === rdfXml) throw error;
                        candidate.load(input, options);
                    }
                } catch (error) {
                    release(candidate);
                    throw error;
                }
                const previous = store;
                store = candidate;
                cachedXml = rdfXml;
                cachedBase = base;
                release(previous);
                timings.loadMs = duration(now, started);
                measuring = null;
            }

            phase = 'querying';
            onStatus(phase);
            measuring = 'queryMs';
            started = now();
            // This entry point accepts queries only; SPARQL Update is never executed.
            const serialized = store.query(queryText, {results_format: 'json', ...(base ? {base_iri: base} : {})});
            timings.queryMs = duration(now, started);
            measuring = 'serializeMs';
            started = now();
            const result = resultJson(serialized);
            timings.serializeMs = duration(now, started);
            measuring = null;
            return {...result, tripleCount: store.size, timings};
        } catch (cause) {
            if (measuring) timings[measuring] = duration(now, started);
            const error = new Error(cause?.message || String(cause));
            error.phase = phase;
            error.timings = timings;
            throw error;
        }
    }

    function dispose() {
        disposed = true;
        release(store);
        store = null;
        cachedXml = null;
        cachedBase = null;
    }

    return Object.freeze({query, dispose});
}
