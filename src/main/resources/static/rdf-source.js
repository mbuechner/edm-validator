/* One RDF/XML source for every tool; Bootstrap provides the shared input controls. */
(() => {
    'use strict';
    const mount = document.getElementById('rdfSource');
    if (!mount) return;
    const storageKey = 'ddb-rdf-source-v1';
    const maxBytes = 1024 * 1024;
    const loadTimeout = 30000;
    const highlightLimit = 200000;
    let source = { rdfXml: '', ddbUri: '', documentIri: null };
    let sourceRevision = 0;
    let contentGeneration = 0;
    let fileGeneration = 0;
    let activeLoad = null;
    let accordionReady = false;
    let requestedExpanded = null;
    const revealWaiters = new Set();
    const subscribers = new Set();
    let highlightTimer = null;
    let editorGeneration = 0;
    let highlightedText = null;
    let composing = false;
    let saveTimer = null;
    let savePending = false;

    mount.innerHTML = `
        <div id="rdfSourceAccordion" class="accordion">
            <div class="accordion-item">
                <h2 id="rdfSourceHeading" class="accordion-header">
                    <button id="rdfSourceToggle" class="accordion-button collapsed" type="button"
                        data-bs-toggle="collapse" data-bs-target="#rdfSourceBody"
                        aria-expanded="false" aria-controls="rdfSourceBody">RDF/XML</button>
                </h2>
                <div id="rdfSourceBody" class="accordion-collapse collapse" aria-labelledby="rdfSourceHeading">
                    <div class="accordion-body">
                        <label for="rdfXmlInput" class="visually-hidden">RDF/XML bearbeiten</label>
                        <div id="rdfSourceEditor" class="rdf-source-editor">
                            <pre class="source-code rdf-source-mirror" aria-hidden="true"><code class="language-markup"></code></pre>
                            <textarea id="rdfXmlInput" name="rdfXml" rows="12" wrap="off" class="source-code form-control font-monospace"
                                spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="rdfSourceHint"></textarea>
                        </div>
                        <div id="rdfSourceHint" class="form-text">Diese Eingabe wird von allen Werkzeugen verwendet.</div>
                        <div class="row g-3 mt-1">
                            <div class="col-12 col-lg-7">
                                <label for="ddbUri" class="form-label">DDB-URI</label>
                                <div class="input-group">
                                    <input id="ddbUri" type="url" class="form-control" autocomplete="url"
                                        placeholder="https://www.deutsche-digitale-bibliothek.de/item/…">
                                    <button id="loadDdbBtn" type="button" class="btn btn-outline-primary">Laden</button>
                                </div>
                            </div>
                            <div class="col-12 col-lg-5">
                                <label for="rdfFile" class="form-label">Datei öffnen</label>
                                <input id="rdfFile" type="file" class="form-control" aria-describedby="rdfFileHint"
                                    accept=".rdf,.xml,.owl,application/rdf+xml,application/xml,text/xml">
                                <div id="rdfFileHint" class="form-text">RDF/XML · bis 1 MiB</div>
                            </div>
                        </div>
                        <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mt-3">
                            <details>
                                <summary class="small">Option für den DDB-Abruf</summary>
                                <div class="form-check mt-2">
                                    <input id="europeanaProfile" type="checkbox" class="form-check-input">
                                    <label for="europeanaProfile" class="form-check-label">Europeana-Profil verwenden</label>
                                </div>
                            </details>
                            <button id="clearRdfBtn" type="button" class="btn btn-outline-secondary btn-sm">Eingabe leeren</button>
                        </div>
                        <div id="rdfSourceOrigin" class="form-text rdf-source-origin"></div>
                    </div>
                </div>
            </div>
        </div>
        <div id="rdfSourceStorageHint" class="form-text text-warning-emphasis d-none" role="status"></div>
        <div id="rdfSourceStatus" class="alert d-none mb-0 mt-3" role="status" aria-live="polite" aria-atomic="true"></div>`;

    const byId = id => document.getElementById(id);
    const xmlInput = byId('rdfXmlInput');
    const uriInput = byId('ddbUri');
    const profileInput = byId('europeanaProfile');
    const fileInput = byId('rdfFile');
    const loadButton = byId('loadDdbBtn');
    const accordionBody = byId('rdfSourceBody');
    const accordionToggle = byId('rdfSourceToggle');
    const editor = byId('rdfSourceEditor');
    const mirror = editor.querySelector('pre');
    const mirrorCode = mirror.querySelector('code');
    const snapshot = () => Object.freeze({ ...source });

    /** Match the native viewport, including scrollbar space, without taking over resizing. */
    function syncEditor() {
        if (xmlInput.clientWidth > 0 && xmlInput.clientHeight > 0) {
            const style = window.getComputedStyle(xmlInput);
            mirror.style.left = style.borderLeftWidth;
            mirror.style.top = style.borderTopWidth;
            mirror.style.width = xmlInput.clientWidth + 'px';
            mirror.style.height = xmlInput.clientHeight + 'px';
            mirror.style.padding = style.padding;
        }
        syncEditorScroll();
    }

    function syncEditorScroll() {
        mirror.scrollTop = xmlInput.scrollTop;
        mirror.scrollLeft = xmlInput.scrollLeft;
    }

    /** Native text stays visible until the exact current source has a complete mirror. */
    function refreshEditor() {
        const text = xmlInput.value;
        if (text === highlightedText && editor.classList.contains('rdf-source-highlighted') && !composing) {
            syncEditor();
            return;
        }
        window.clearTimeout(highlightTimer);
        highlightTimer = null;
        const generation = ++editorGeneration;
        highlightedText = null;
        editor.classList.remove('rdf-source-highlighted');
        // A final space preserves the native textarea's last, empty line in a <pre>.
        const ending = text.endsWith('\n') ? ' ' : '';
        mirrorCode.textContent = text + ending;
        syncEditor();
        const prism = window.Prism;
        const grammar = prism?.languages?.markup;
        const safeHighlight = typeof window.CodeView?.highlight === 'function' ? window.CodeView.highlight : null;
        if (!text || composing || text.length > highlightLimit || !grammar || (!safeHighlight && typeof prism.highlight !== 'function')) return;
        highlightTimer = window.setTimeout(() => {
            highlightTimer = null;
            if (generation !== editorGeneration || xmlInput.value !== text || composing) return;
            try {
                if (safeHighlight) {
                    if (!safeHighlight(mirrorCode, text, 'markup')) {
                        mirrorCode.textContent = text + ending;
                        return;
                    }
                } else {
                    const markup = prism.highlight(text, grammar, 'markup');
                    if (typeof markup !== 'string') return;
                    mirrorCode.innerHTML = markup;
                }
                if (generation !== editorGeneration || xmlInput.value !== text) return;
                // Keep unusual Unicode whitespace readable if a grammar normalizes it.
                if (mirrorCode.textContent !== text) {
                    mirrorCode.textContent = text + ending;
                    return;
                }
                if (ending) mirrorCode.append(document.createTextNode(ending));
                highlightedText = text;
                editor.classList.add('rdf-source-highlighted');
                syncEditor();
            } catch (_) {
                mirrorCode.textContent = text + ending;
                editor.classList.remove('rdf-source-highlighted');
            }
        }, 100);
    }

    xmlInput.addEventListener('scroll', syncEditorScroll, { passive: true });
    xmlInput.addEventListener('focus', refreshEditor);
    xmlInput.addEventListener('compositionstart', () => { composing = true; refreshEditor(); });
    xmlInput.addEventListener('compositionend', () => { composing = false; refreshEditor(); });
    window.addEventListener('resize', syncEditor);
    if (typeof window.ResizeObserver === 'function') new window.ResizeObserver(syncEditor).observe(xmlInput);

    function finishReveal() {
        if (!accordionBody.classList.contains('show') || accordionBody.classList.contains('collapsing')) return;
        for (const resolve of revealWaiters) resolve();
        revealWaiters.clear();
    }

    function fallbackExpanded(expanded, initial = false) {
        const changed = accordionBody.classList.contains('show') !== expanded;
        if (changed && !initial && !accordionBody.dispatchEvent(new CustomEvent((expanded ? 'show' : 'hide') + '.bs.collapse',
            { bubbles: true, cancelable: true }))) return;
        accordionBody.classList.toggle('show', expanded);
        // Native hidden is only a fallback: Bootstrap needs measurable content while
        // starting its height transition, so its CSS controls visibility when available.
        accordionBody.hidden = !expanded && typeof window.bootstrap?.Collapse?.getOrCreateInstance !== 'function';
        accordionToggle.classList.toggle('collapsed', !expanded);
        accordionToggle.setAttribute('aria-expanded', String(expanded));
        if (changed && !initial) accordionBody.dispatchEvent(new CustomEvent((expanded ? 'shown' : 'hidden') + '.bs.collapse', { bubbles: true }));
        finishReveal();
    }

    function driveAccordion() {
        if (!accordionReady || requestedExpanded === null || accordionBody.classList.contains('collapsing')) return;
        if (accordionBody.classList.contains('show') === requestedExpanded) {
            requestedExpanded = null;
            finishReveal();
            return;
        }
        const Collapse = window.bootstrap?.Collapse;
        if (typeof Collapse?.getOrCreateInstance === 'function') {
            // Bootstrap owns animation and ARIA state; wait for its public completion events
            // when a new source arrives while an earlier open/close is still transitioning.
            accordionBody.hidden = false;
            const collapse = Collapse.getOrCreateInstance(accordionBody, { toggle: false });
            collapse[requestedExpanded ? 'show' : 'hide']();
        } else fallbackExpanded(requestedExpanded);
    }

    function setExpanded(expanded) {
        requestedExpanded = expanded;
        driveAccordion();
    }

    /** Resolve once the source field is visible, so tools can then focus invalid input. */
    function reveal() {
        return new Promise(resolve => {
            revealWaiters.add(resolve);
            setExpanded(true);
        });
    }

    for (const event of ['shown.bs.collapse', 'hidden.bs.collapse']) {
        accordionBody.addEventListener(event, () => {
            if (event === 'shown.bs.collapse') { refreshEditor(); syncEditor(); }
            finishReveal();
            driveAccordion();
        });
    }
    accordionToggle.addEventListener('click', () => {
        requestedExpanded = null;
        if (typeof window.bootstrap?.Collapse?.getOrCreateInstance === 'function') {
            accordionBody.hidden = false; // A late-loaded Bootstrap bundle can take over the fallback.
        } else setExpanded(!accordionBody.classList.contains('show'));
    });

    function storageHint(failed) {
        const hint = byId('rdfSourceStorageHint');
        hint.textContent = failed ? 'Die Eingabe kann in diesem Browser nicht gespeichert werden. Sie bleibt auf dieser Seite nutzbar.' : '';
        hint.classList.toggle('d-none', !failed);
    }

    /** Serialize a typing burst once; completed loads and navigation flush immediately. */
    function flushSave() {
        if (!savePending) return;
        window.clearTimeout(saveTimer);
        saveTimer = null;
        savePending = false;
        try {
            // Persist an empty source too: clearing must never restore an older draft.
            localStorage.setItem(storageKey, JSON.stringify({ ...source, europeanaProfile: profileInput.checked }));
            storageHint(false);
            return true;
        } catch (_) {
            storageHint(true);
            return false;
        }
    }

    function save(deferred = false) {
        savePending = true;
        window.clearTimeout(saveTimer);
        if (deferred && source.rdfXml) saveTimer = window.setTimeout(flushSave, 250);
        else flushSave();
    }

    function status(message = '', type = 'info') {
        const element = byId('rdfSourceStatus');
        element.textContent = message;
        element.className = 'alert alert-' + type + ' mb-0 mt-3' + (message ? '' : ' d-none');
    }

    function updateControls() {
        if (xmlInput.value !== source.rdfXml) xmlInput.value = source.rdfXml;
        refreshEditor();
        if (uriInput.value !== source.ddbUri) uriInput.value = source.ddbUri;
        byId('rdfSourceOrigin').textContent = source.documentIri ? 'Dokument-IRI: ' + source.documentIri : '';
    }

    function publish() {
        sourceRevision++;
        const value = snapshot();
        document.dispatchEvent(new CustomEvent('rdf-source-change', {
            detail: Object.freeze({ ...value, revision: sourceRevision })
        }));
        for (const subscriber of [...subscribers]) subscriber(value, sourceRevision);
    }

    function setLoading(loading) {
        loadButton.disabled = loading;
        loadButton.textContent = loading ? 'Wird geladen …' : 'Laden';
        mount.setAttribute('aria-busy', String(loading));
    }

    function cancelLoad() {
        if (!activeLoad) return;
        const pending = activeLoad;
        activeLoad = null;
        window.clearTimeout(pending.timeout);
        pending.controller.abort();
        setLoading(false);
    }

    /** Replacing content cancels pending reads, including responses that ignore abort. */
    function replace(value, persist = true, { completed = true } = {}) {
        const next = {
            rdfXml: typeof value.rdfXml === 'string' ? value.rdfXml : '',
            ddbUri: typeof value.ddbUri === 'string' ? value.ddbUri : source.ddbUri,
            documentIri: typeof value.documentIri === 'string' && value.documentIri ? value.documentIri : null
        };
        contentGeneration++;
        fileGeneration++;
        cancelLoad();
        const changed = next.rdfXml !== source.rdfXml || next.documentIri !== source.documentIri;
        source = next;
        updateControls();
        if (completed || !source.rdfXml.trim()) setExpanded(!source.rdfXml.trim());
        if (persist) save(!completed);
        else {
            // A newer source from another tab supersedes this tab's pending draft.
            window.clearTimeout(saveTimer);
            saveTimer = null;
            savePending = false;
        }
        if (changed) publish();
    }

    function readStored(text) {
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.rdfXml !== 'string') throw new Error('Invalid source');
        return {
            rdfXml: data.rdfXml,
            ddbUri: typeof data.ddbUri === 'string' ? data.ddbUri : '',
            documentIri: typeof data.documentIri === 'string' && data.documentIri ? data.documentIri : null,
            europeanaProfile: data.europeanaProfile === true
        };
    }

    function restore() {
        let stored;
        let handoff = null;
        try {
            handoff = sessionStorage.getItem('ddb-edm-converter-handoff-v1');
            sessionStorage.removeItem('ddb-edm-converter-handoff-v1');
        } catch (_) { /* Browser session storage is optional. */ }
        try {
            stored = localStorage.getItem(storageKey);
            if (stored !== null) {
                // The common store is authoritative even when empty or damaged.
                let data;
                let invalid = false;
                try { data = readStored(stored); }
                catch (_) { invalid = true; data = { rdfXml: '', ddbUri: '', documentIri: null }; }
                profileInput.checked = data.europeanaProfile === true;
                replace(data, false);
                if (invalid) save();
                return;
            }
            const legacyUri = localStorage.getItem('ddb-edm-validator-uri') || '';
            let data = null;
            if (handoff !== null) {
                try { data = readStored(handoff); } catch (_) { /* Try another existing draft. */ }
            }
            if (!data) {
                const converterDraft = localStorage.getItem('ddb-edm-converter-input-v1');
                if (converterDraft !== null) {
                    try {
                        data = readStored(converterDraft);
                        const legacy = JSON.parse(converterDraft);
                        if (!data.documentIri && typeof legacy.baseIri === 'string' && legacy.baseIri) data.documentIri = legacy.baseIri;
                    } catch (_) { /* Try the validator's RDF/XML draft. */ }
                }
            }
            if (!data) {
                const xml = localStorage.getItem('ddb-edm-validator-xml');
                if (xml !== null) data = { rdfXml: xml, documentIri: null };
            }
            if (data || legacyUri) {
                replace({ ...data, ddbUri: data?.ddbUri || legacyUri });
            }
        } catch (_) {
            storageHint(true);
            // A valid one-time handoff remains useful when persistent storage is blocked.
            if (handoff !== null) {
                try { replace(readStored(handoff)); } catch (_) { /* Manual input remains available. */ }
            }
        }
    }

    async function loadDdb() {
        if (activeLoad) return;
        const ddbUri = uriInput.value.trim();
        if (!ddbUri) {
            status('Bitte eine DDB-URI eingeben.', 'warning');
            await reveal();
            uriInput.focus();
            return;
        }
        source.ddbUri = ddbUri;
        uriInput.value = ddbUri;
        save();
        fileGeneration++;
        const pending = { controller: new AbortController(), generation: contentGeneration, timeout: null, timedOut: false };
        activeLoad = pending;
        pending.timeout = window.setTimeout(() => {
            if (activeLoad !== pending) return;
            pending.timedOut = true;
            activeLoad = null;
            pending.controller.abort();
            setLoading(false);
            status('Der DDB-Abruf dauert zu lange. Bitte erneut versuchen.', 'danger');
        }, loadTimeout);
        setLoading(true);
        status();
        try {
            let response;
            try {
                response = await fetch('./api/source', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({ ddbUri, europeanaProfile: profileInput.checked }), signal: pending.controller.signal
                });
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                throw new Error('Keine Verbindung zur Anwendung unter ' + window.location.origin
                    + '. Bitte prüfen, ob die Anwendung läuft, und danach erneut versuchen.');
            }
            const data = await response.json();
            if (activeLoad !== pending || pending.generation !== contentGeneration) return;
            if (pending.timedOut) throw new Error('Der DDB-Abruf dauert zu lange. Bitte erneut versuchen.');
            if (!response.ok || data.error || typeof data.rdfXml !== 'string') {
                throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Das RDF/XML konnte nicht von der DDB geladen werden.');
            }
            replace({ rdfXml: data.rdfXml, ddbUri: typeof data.ddbUri === 'string' ? data.ddbUri : ddbUri,
                documentIri: typeof data.apiUrl === 'string' ? data.apiUrl : null });
            status('RDF/XML wurde geladen.', 'success');
        } catch (error) {
            if (activeLoad !== pending || pending.generation !== contentGeneration) return;
            status(pending.timedOut ? 'Der DDB-Abruf dauert zu lange. Bitte erneut versuchen.'
                : error?.message || 'Das RDF/XML konnte nicht geladen werden.', 'danger');
        } finally {
            window.clearTimeout(pending.timeout);
            if (activeLoad === pending) {
                activeLoad = null;
                setLoading(false);
            }
        }
    }

    async function decodeFile(file) {
        const buffer = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Die Datei konnte nicht gelesen werden.'));
            reader.readAsArrayBuffer(file);
        });
        if (buffer.byteLength > maxBytes) throw new Error('Die Datei darf höchstens 1 MiB groß sein.');
        const bytes = new Uint8Array(buffer);
        if ((bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)
            || (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0)) {
            throw new Error('UTF-32 wird nicht unterstützt. Bitte die Datei als UTF-8 oder UTF-16 speichern.');
        }
        let encoding = 'utf-8';
        if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)) encoding = 'utf-16le';
        else if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)) encoding = 'utf-16be';
        else if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
            const declaration = new TextDecoder('ascii').decode(bytes.slice(0, 512))
                .match(/^\s*<\?xml\s[^?]*encoding\s*=\s*["']([^"']+)["']/i);
            if (declaration) encoding = declaration[1];
        }
        return new TextDecoder(encoding, { fatal: true }).decode(buffer)
            .replace(/^(\s*<\?xml\s[^?]*encoding\s*=\s*)["'][^"']+["']/i, '$1"UTF-8"');
    }

    xmlInput.addEventListener('input', () => {
        // Editing a loaded document keeps its base for relative RDF IRIs.
        replace({ ...source, rdfXml: xmlInput.value }, true, { completed: false });
        status();
    });
    uriInput.addEventListener('input', () => {
        source.ddbUri = uriInput.value;
        save(true); // A candidate URI does not change the current RDF document or its revision.
    });
    uriInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); loadDdb(); }
    });
    profileInput.addEventListener('change', () => save());
    loadButton.addEventListener('click', loadDdb);
    byId('clearRdfBtn').addEventListener('click', async () => {
        profileInput.checked = false;
        fileInput.value = '';
        replace({ rdfXml: '', ddbUri: '', documentIri: null });
        status();
        await reveal();
        xmlInput.focus();
    });
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        cancelLoad();
        const generation = ++fileGeneration;
        status();
        try {
            if (file.size > maxBytes) throw new Error('Die Datei darf höchstens 1 MiB groß sein.');
            const xml = await decodeFile(file);
            if (generation !== fileGeneration) return;
            if (!xml.trim()) throw new Error('Die Datei ist leer. Bitte eine RDF/XML-Datei auswählen.');
            replace({ rdfXml: xml, documentIri: null });
            status('Datei „' + file.name + '“ wurde geladen.', 'success');
        } catch (error) {
            if (generation === fileGeneration) status(error?.message || 'Die Datei konnte nicht gelesen werden.', 'danger');
        } finally {
            if (generation === fileGeneration || !fileInput.files?.[0] || fileInput.files[0] === file) fileInput.value = '';
        }
    });
    window.addEventListener('storage', event => {
        if (event.key !== storageKey && event.key !== null) return;
        let data;
        try { data = event.newValue === null ? { rdfXml: '', ddbUri: '', documentIri: null } : readStored(event.newValue); }
        catch (_) { data = { rdfXml: '', ddbUri: '', documentIri: null }; }
        let candidateOnly = false;
        if (event.key === storageKey && event.newValue !== null) {
            try {
                const before = event.oldValue === null ? { rdfXml: '', documentIri: null } : readStored(event.oldValue);
                candidateOnly = before.rdfXml === data.rdfXml && before.documentIri === data.documentIri;
            } catch (_) { /* Unknown previous content cannot establish a metadata-only edit. */ }
        }
        profileInput.checked = data.europeanaProfile === true;
        if (candidateOnly || (data.rdfXml === source.rdfXml && data.documentIri === source.documentIri)) {
            source.ddbUri = data.ddbUri;
            if (uriInput.value !== source.ddbUri) uriInput.value = source.ddbUri;
        } else replace(data, false);
        status();
    });
    window.addEventListener('pagehide', () => {
        flushSave();
        cancelLoad();
        fileGeneration++;
        window.clearTimeout(highlightTimer);
        highlightTimer = null;
        editorGeneration++;
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushSave();
    });
    document.addEventListener('click', event => {
        if (event.target.closest?.('a[href]')) flushSave();
    }, true);
    window.addEventListener('pageshow', refreshEditor);

    restore();
    fallbackExpanded(!source.rdfXml.trim(), true);
    requestedExpanded = null;
    accordionReady = true;
    refreshEditor();
    window.RdfSource = Object.freeze({
        get: snapshot,
        revision: () => sourceRevision,
        reveal,
        set(value) { replace(value); status(); },
        subscribe(callback) {
            if (typeof callback !== 'function') throw new TypeError('A source subscriber must be a function.');
            subscribers.add(callback);
            return () => subscribers.delete(callback);
        }
    });
})();
