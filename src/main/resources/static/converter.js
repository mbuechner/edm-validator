/* One document in, one document out. Advanced RDF settings are optional. */
(() => {
    'use strict';
    const byId = id => document.getElementById(id);
    const form = byId('converterForm');
    if (!form) return;
    const maxBytes = 1024 * 1024;
    const highlightLimit = 200_000;
    const inputStorageKey = 'ddb-edm-converter-input-v1';
    const labels = {
        compacted: 'JSON-LD · Kompakt',
        expanded: 'JSON-LD · Expandiert'
    };
    const hints = {
        compacted: 'Kurze Bezeichnungen aus dem Kontext. Geeignet für die meisten Anwendungen.',
        expanded: 'Vollständige IRIs und explizite Werte. Die Ausgabe enthält keinen Kontext.'
    };
    const structureHints = {
        standard: 'Den vollständigen RDF-Graphen ohne zusätzliche Strukturvorgaben ausgeben.',
        flattened: 'Jede Ressource wird als eigener Knoten beschrieben. Der vollständige Graph bleibt erhalten.',
        framed: 'Eine Wurzelressource mit eingebetteten Beziehungen. Diese Ansicht kann Teile des Graphen auslassen.'
    };
    const xmlRepresentationHints = {
        explicit: 'Verwendet rdf:Description und explizite rdf:type-Aussagen.',
        typed: 'Verwendet passende RDF-Typen als XML-Elementnamen. Nicht als XML-QName darstellbare Typen bleiben als rdf:type-Aussagen erhalten.'
    };
    const xmlStructureHints = {
        flat: 'Ressourcen stehen direkt unter rdf:RDF; Verknüpfungen verwenden rdf:resource oder rdf:nodeID.',
        nested: 'Der Writer verschachtelt Ressourcen, soweit möglich. Gemeinsam genutzte oder zyklisch verknüpfte Knoten können Referenzen bleiben.'
    };
    const editors = new Map();
    let revision = 0;
    let sourceRevision = 0;
    let inspectedRevision = -1;
    let inspectingRevision = -1;
    let sourceFile = null;
    let documentIri = null;
    let automaticContext = '{ "@context": {} }';
    let metadataIssues = [];
    let effectiveFrame = null;
    let frameDraftInitialized = false;
    let fileReadToken = 0;
    let fileLoading = false;
    let processing = false;
    let hasResult = false;
    let convertController = null;
    let inspectController = null;
    let inspectTimer = null;
    let inputSaveTimer = null;
    let inputSavePending = false;

    const selected = name => form.querySelector('input[name="' + name + '"]:checked')?.value;
    const visible = (id, show) => byId(id)?.classList.toggle('d-none', !show);
    const isJson = () => byId('converterJsonLd').checked;
    const representation = () => byId('converterMethod').value;
    const structure = () => byId('converterStructure').value;
    const xmlRepresentation = () => byId('converterXmlRepresentation').value;
    const xmlStructure = () => byId('converterXmlStructure').value;
    const method = () => structure() === 'standard' ? representation() : structure();
    const jsonLabel = () => labels[representation()] + (structure() === 'flattened' ? ' · Getrennte Knoten' :
        structure() === 'framed' ? ' · Eingebettet' : '');
    const xmlSummary = () => ['converterXmlRepresentation', 'converterXmlStructure']
        .map(id => byId(id).selectedOptions[0]?.textContent.trim() || '').join(' · ');
    const xmlLabel = () => 'RDF/XML · ' + xmlSummary();

    function removeSavedInput() {
        window.clearTimeout(inputSaveTimer);
        inputSavePending = false;
        try { localStorage.removeItem(inputStorageKey); } catch (_) { /* Storage is optional. */ }
    }

    function flushSavedInput() {
        if (!inputSavePending) return;
        window.clearTimeout(inputSaveTimer);
        inputSavePending = false;
        const rdfXml = byId('converterInput').value;
        try {
            if (rdfXml === '') localStorage.removeItem(inputStorageKey);
            else localStorage.setItem(inputStorageKey, JSON.stringify({
                rdfXml, baseIri: byId('converterBase').value, documentIri
            }));
        } catch (_) { /* Blocked storage or a full quota must not prevent conversion. */ }
    }

    function scheduleSaveInput() {
        window.clearTimeout(inputSaveTimer);
        inputSavePending = true;
        if (byId('converterInput').value === '') flushSavedInput();
        else inputSaveTimer = window.setTimeout(flushSavedInput, 250);
    }

    function restoreSavedInput() {
        let saved;
        try { saved = localStorage.getItem(inputStorageKey); } catch (_) { return; }
        if (saved === null) return;
        try {
            const data = JSON.parse(saved);
            if (!data || typeof data.rdfXml !== 'string' || data.rdfXml === '') throw new Error();
            byId('converterInput').value = data.rdfXml;
            byId('converterBase').value = typeof data.baseIri === 'string' ? data.baseIri : '';
            documentIri = typeof data.documentIri === 'string' ? data.documentIri : null;
            byId('converterSource').textContent = documentIri ? 'Dokument-IRI: ' + documentIri : 'Gespeicherte Eingabe';
            invalidate(true, false);
        } catch (_) { removeSavedInput(); }
    }

    function sourceText(code, text, highlight = true) {
        const value = text || '';
        if (code.textContent !== value) code.textContent = value;
        if (highlight && value.length <= highlightLimit && window.Prism) Prism.highlightElement(code);
    }

    function isVisible(element) {
        return !element.closest('.d-none, details:not([open])');
    }

    function queueEditor(textarea) {
        let state = editors.get(textarea);
        if (!state) {
            state = { frame: null, timer: null, highlighted: null };
            editors.set(textarea, state);
        }
        window.clearTimeout(state.timer);
        if (!window.Prism || state.highlighted !== textarea.value || textarea.value.length > highlightLimit) {
            textarea.parentElement.classList.remove('converter-editor-highlighted');
        }
        if (state.frame !== null) return;
        state.frame = window.requestAnimationFrame(() => {
            state.frame = null;
            const pre = textarea.parentElement.querySelector('pre');
            const code = pre.querySelector('code');
            const large = textarea.value.length > highlightLimit;
            textarea.parentElement.classList.toggle('converter-editor-plain', large);
            if (textarea.id === 'converterInput') visible('converterHighlightHint', large);
            const mirrored = large ? '' : textarea.value + (textarea.value.endsWith('\n') ? ' ' : '');
            if (code.textContent !== mirrored) {
                code.textContent = mirrored;
                state.highlighted = null;
            }
            pre.scrollTop = textarea.scrollTop;
            pre.scrollLeft = textarea.scrollLeft;
            if (!large && textarea.value && state.highlighted !== textarea.value && isVisible(textarea)) {
                const value = textarea.value;
                state.timer = window.setTimeout(() => {
                    if (isVisible(textarea) && textarea.value === value && window.Prism) {
                        try {
                            Prism.highlightElement(code);
                            state.highlighted = value;
                            textarea.parentElement.classList.add('converter-editor-highlighted');
                        } catch (_) {
                            state.highlighted = null;
                            textarea.parentElement.classList.remove('converter-editor-highlighted');
                        }
                    }
                }, 120);
            }
        });
    }

    function status(message, type = 'info') {
        const element = byId('converterStatus');
        if (window.AppMessages) window.AppMessages.show(element, type, message);
        else {
            element.className = 'alert alert-' + type + ' mb-3';
            element.textContent = message;
        }
    }

    function setBusy(busy) {
        processing = busy;
        byId('converterSubmit').disabled = busy || fileLoading;
        byId('converterSubmit').textContent = busy ? 'Wird konvertiert …' : 'Konvertieren';
        byId('converterOutputPanel').setAttribute('aria-busy', String(busy));
    }

    function clearErrors() {
        for (const id of ['converterInputError', 'converterBaseError', 'converterContextError',
            'converterFrameError', 'converterOutputError', 'converterErrors']) byId(id).textContent = '';
        visible('converterErrors', false);
        for (const element of form.querySelectorAll('[aria-invalid]')) element.removeAttribute('aria-invalid');
    }

    function reveal(element) {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (parent.tagName === 'DETAILS') parent.open = true;
        }
    }

    function showErrors(issues, metadataOnly = false, focus = false) {
        const targets = {
            rdfXml: ['converterInputError', 'converterInput'],
            file: ['converterInputError', 'converterFile'],
            baseIri: ['converterBaseError', 'converterBase'],
            documentIri: ['converterBaseError', 'converterBase'],
            context: ['converterContextError', selected('converterContextMode') === 'custom' ? 'converterContext' : 'converterContextAuto'],
            frame: ['converterFrameError', selected('converterFrameMode') === 'custom' ? 'converterFrame' : 'converterRoot'],
            rootIri: ['converterFrameError', 'converterRoot'],
            embed: ['converterFrameError', 'converterEmbedOnce'],
            methods: ['converterOutputError', 'converterMethod'],
            representation: ['converterOutputError', 'converterMethod'],
            xmlRepresentation: ['converterOutputError', 'converterXmlRepresentation'],
            xmlStructure: ['converterOutputError', 'converterXmlStructure'],
            outputs: ['converterOutputError', 'converterJsonLd']
        };
        let first = null;
        const messages = [];
        for (const issue of issues || []) {
            if (metadataOnly && !['rdfXml', 'file', 'baseIri', 'documentIri'].includes(issue.field)) continue;
            if (!metadataOnly && !messages.includes(issue.message)) messages.push(issue.message);
            const target = targets[issue.field];
            if (target) {
                byId(target[0]).textContent = issue.message;
                const field = byId(target[1]);
                field.setAttribute('aria-invalid', 'true');
                reveal(field);
                first ||= field;
            }
        }
        if (messages.length) {
            visible('converterStatus', false);
            const host = byId('converterErrors');
            if (window.AppMessages) window.AppMessages.show(host, 'danger', messages.join(' '));
            else {
                host.className = 'alert alert-danger mb-3';
                host.textContent = messages.join(' ');
            }
        }
        if (focus && first) first.focus();
        return first;
    }

    function contextValue() {
        const raw = selected('converterContextMode') === 'custom' ? byId('converterContext').value : automaticContext;
        const document = JSON.parse(raw);
        if (!document || typeof document !== 'object' || Array.isArray(document) || !Object.hasOwn(document, '@context')) {
            throw new Error('Ein JSON-Dokument mit oberster @context-Eigenschaft ist erforderlich.');
        }
        return document['@context'];
    }

    function generatedFrame() {
        const frame = { '@context': contextValue(), '@embed': selected('converterEmbed') };
        const root = byId('converterRoot').value.trim();
        if (root) frame['@id'] = root;
        return frame;
    }

    function updateFramePreview() {
        if (!isJson() || method() !== 'framed' || !byId('converterFramePreviewDetails').open) return;
        byId('converterFramePreviewLabel').textContent = effectiveFrame ? 'Tatsächlich verwendetes Frame' : 'Frame-Vorschau';
        try {
            let text = effectiveFrame;
            if (!text) {
                let frame;
                if (selected('converterFrameMode') === 'custom') {
                    frame = JSON.parse(byId('converterFrame').value);
                    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Das Frame muss ein JSON-Objekt sein.');
                    if (!Object.hasOwn(frame, '@context')) frame['@context'] = contextValue();
                } else frame = generatedFrame();
                text = JSON.stringify(frame, null, 2);
            }
            sourceText(byId('converterFramePreview'), text);
        } catch (error) {
            sourceText(byId('converterFramePreview'), 'Keine gültige Vorschau: ' + error.message, false);
        }
    }

    function syncOptions() {
        const json = isJson();
        const framed = json && structure() === 'framed';
        visible('converterJsonOptions', json);
        visible('converterXmlOptions', !json);
        byId('converterXmlRepresentation').disabled = json;
        byId('converterXmlStructure').disabled = json;
        byId('converterMethod').disabled = !json;
        byId('converterStructure').disabled = !json;
        byId('converterMethodHint').textContent = hints[representation()];
        byId('converterStructureHint').textContent = structureHints[structure()];
        byId('converterMethodSummary').textContent = jsonLabel();
        byId('converterXmlSummary').textContent = xmlSummary();
        byId('converterXmlRepresentationHint').textContent = xmlRepresentationHints[xmlRepresentation()];
        byId('converterXmlStructureHint').textContent = xmlStructureHints[xmlStructure()];
        visible('converterContextOptions', json && (representation() === 'compacted' || framed));
        byId('converterContextPurpose').textContent = framed && representation() === 'expanded' ?
            'Der Kontext interpretiert die Frame-Regeln. Die expandierte Ausgabe enthält keinen @context.' :
            'Der Kontext legt kurze Bezeichnungen für IRIs fest und wird automatisch erzeugt.';
        visible('converterFrameOptions', framed);
        const customContext = selected('converterContextMode') === 'custom';
        visible('converterAutoContextBox', !customContext);
        visible('converterCustomContextBox', customContext);
        const customFrame = selected('converterFrameMode') === 'custom';
        if (framed && customFrame && !frameDraftInitialized) {
            try { byId('converterFrame').value = JSON.stringify(generatedFrame(), null, 2); }
            catch (_) { byId('converterFrame').value = '{\n  "@embed": "@once"\n}'; }
            frameDraftInitialized = true;
            queueEditor(byId('converterFrame'));
        }
        byId('converterFrameFields').disabled = customFrame;
        byId('converterRoot').setAttribute('aria-required', String(framed && !customFrame));
        visible('converterFrameEditorBox', customFrame);
        for (const id of ['converterContext', 'converterFrame']) {
            if (isVisible(byId(id))) queueEditor(byId(id));
        }
        updateFramePreview();
    }

    function modelInput() {
        return {
            rdfXml: byId('converterInput').value,
            baseIri: byId('converterBase').value.trim() || null,
            documentIri
        };
    }

    function requestData() {
        const input = modelInput();
        if (!isJson()) return {
            ...input, rdfXmlOutput: true, jsonLdOutput: false,
            xmlRepresentation: xmlRepresentation(), xmlStructure: xmlStructure()
        };
        const data = {
            ...input, rdfXmlOutput: false, jsonLdOutput: true,
            methods: [method()], representation: representation()
        };
        if (representation() === 'compacted' || structure() === 'framed') {
            data.contextMode = selected('converterContextMode');
            if (data.contextMode === 'custom') data.context = byId('converterContext').value;
        }
        if (structure() === 'framed') {
            data.frameMode = selected('converterFrameMode');
            if (data.frameMode === 'custom') data.frame = byId('converterFrame').value;
            else {
                data.rootIri = byId('converterRoot').value.trim() || null;
                data.embed = selected('converterEmbed');
            }
        }
        return data;
    }

    function wantsMetadata() {
        return byId('converterAdvanced').open && isJson() && byId('converterInput').value.trim();
    }

    function cancelInspect() {
        window.clearTimeout(inspectTimer);
        inspectController?.abort();
        inspectController = null;
        inspectingRevision = -1;
    }

    function scheduleInspect() {
        window.clearTimeout(inspectTimer);
        if (processing || !wantsMetadata() || inspectedRevision === sourceRevision || inspectingRevision === sourceRevision) return;
        inspectTimer = window.setTimeout(inspect, 450);
    }

    function invalidate(sourceChanged = false, schedule = true) {
        revision++;
        convertController?.abort();
        effectiveFrame = null;
        const previousResult = hasResult;
        hasResult = false;
        byId('converterResults').replaceChildren();
        visible('converterEmptyState', true);
        setBusy(false);
        clearErrors();
        if (sourceChanged) {
            sourceRevision++;
            cancelInspect();
            inspectedRevision = -1;
            automaticContext = '{ "@context": {} }';
            metadataIssues = [];
            byId('converterResources').replaceChildren();
            sourceText(byId('converterAutoContext'), automaticContext, false);
        } else showErrors(metadataIssues, true);
        if (previousResult) status('Eingabe oder Einstellungen geändert. Bitte erneut konvertieren.');
        else visible('converterStatus', false);
        if (schedule) scheduleInspect();
    }

    function updateMetadata(data) {
        if (typeof data.autoContext === 'string') {
            automaticContext = data.autoContext;
            sourceText(byId('converterAutoContext'), automaticContext, byId('converterAutoContextDetails').open);
        }
        if (Array.isArray(data.resources)) {
            byId('converterResources').replaceChildren(...data.resources.map(iri => {
                const option = document.createElement('option');
                option.value = iri;
                return option;
            }));
        }
        updateFramePreview();
    }

    async function api(path, data, signal, upload = false) {
        const options = { method: 'POST', signal };
        if (upload) {
            const body = new FormData();
            body.append('file', sourceFile);
            body.append('options', JSON.stringify({ ...data, rdfXml: null }));
            options.body = body;
        } else {
            options.headers = { 'Content-Type': 'application/json' };
            options.body = JSON.stringify(data);
        }
        const response = await fetch('./api/convert' + path, options);
        let payload;
        try { payload = await response.json(); }
        catch (_) { throw new Error('Der Server lieferte keine lesbare Antwort (HTTP ' + response.status + ').'); }
        if (!response.ok && !Array.isArray(payload.errors)) {
            throw new Error(payload.message || 'Die Anfrage ist fehlgeschlagen (HTTP ' + response.status + ').');
        }
        return payload;
    }

    async function inspect() {
        if (processing || !wantsMetadata() || inspectedRevision === sourceRevision) return;
        if (new TextEncoder().encode(byId('converterInput').value).length > maxBytes) return;
        const version = sourceRevision;
        const controller = new AbortController();
        inspectController = controller;
        inspectingRevision = version;
        try {
            // Only model metadata is needed here, never a transformation or a frame.
            const data = await api('/inspect', { ...modelInput(), rdfXmlOutput: false, jsonLdOutput: false }, controller.signal);
            if (sourceRevision !== version || controller.signal.aborted || !wantsMetadata()) return;
            inspectedRevision = version;
            metadataIssues = (data.errors || []).filter(issue => ['rdfXml', 'file', 'baseIri', 'documentIri'].includes(issue.field));
            updateMetadata(data);
            showErrors(metadataIssues, true);
        } catch (error) {
            if (error.name !== 'AbortError' && sourceRevision === version && !controller.signal.aborted) {
                byId('converterInputError').textContent = 'Vorschau nicht verfügbar: ' + error.message;
            }
        } finally {
            if (inspectController === controller) {
                inspectController = null;
                inspectingRevision = -1;
            }
        }
    }

    function download(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function copyContent(content, source) {
        if (navigator.clipboard?.writeText) {
            try { await navigator.clipboard.writeText(content); return true; }
            catch (_) { /* Select the source if browser clipboard access is unavailable. */ }
        }
        source.focus();
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return false;
    }

    function renderResult(item) {
        if (!item || item.error) return false;
        visible('converterEmptyState', false);
        const article = document.createElement('article');
        const title = document.createElement('h3');
        title.className = 'h6';
        title.textContent = item.id === 'rdfxml' ? xmlLabel() : jsonLabel();
        article.append(title);
        {
            const toolbar = document.createElement('div');
            toolbar.className = 'd-flex flex-wrap justify-content-between align-items-center gap-2 mb-3';
            const info = document.createElement('span');
            info.className = 'small text-body-secondary text-break';
            info.textContent = item.fileName + ' · ' + Number(item.sizeBytes).toLocaleString('de-DE') + ' Bytes';
            const actions = document.createElement('div');
            actions.className = 'd-flex flex-wrap gap-2';
            const copy = document.createElement('button');
            copy.type = 'button';
            copy.className = 'btn btn-sm btn-outline-secondary';
            copy.textContent = 'Kopieren';
            copy.setAttribute('aria-label', title.textContent + ' kopieren');
            const save = document.createElement('button');
            save.type = 'button';
            save.className = 'btn btn-sm btn-primary';
            save.textContent = 'Herunterladen';
            save.setAttribute('aria-label', item.fileName + ' herunterladen');
            const pre = document.createElement('pre');
            pre.className = 'source-code converter-result-source border rounded bg-body-tertiary p-3 mb-0 overflow-auto font-monospace focus-ring';
            pre.tabIndex = 0;
            pre.setAttribute('aria-label', title.textContent + ' Quelltext (schreibgeschützt)');
            const code = document.createElement('code');
            code.className = item.id === 'rdfxml' ? 'language-markup' : 'language-json';
            pre.append(code);
            copy.addEventListener('click', async () => {
                const copied = await copyContent(item.content, pre);
                status(copied ? item.fileName + ' wurde kopiert.' :
                    'Automatisches Kopieren ist nicht verfügbar. Der Quelltext ist markiert und kann mit Strg+C kopiert werden.', copied ? 'success' : 'info');
            });
            save.addEventListener('click', () => download(new Blob([item.content], {
                type: item.mediaType + ';charset=utf-8'
            }), item.fileName));
            actions.append(copy, save);
            toolbar.append(info, actions);
            article.append(toolbar);
            article.append(pre);
            sourceText(code, item.content);
            hasResult = true;
        }
        byId('converterResults').append(article);
        return hasResult;
    }

    function checkInput(data) {
        let issue;
        if (!data.rdfXml.trim()) issue = { field: 'rdfXml', message: 'Bitte RDF/XML einfügen oder eine Datei hochladen.' };
        else if ((sourceFile?.size || new TextEncoder().encode(data.rdfXml).length) > maxBytes) {
            issue = { field: 'rdfXml', message: 'Die Eingabe darf höchstens 1 MiB groß sein.' };
        } else if (data.jsonLdOutput && method() === 'framed' && data.frameMode !== 'custom' && !data.rootIri) {
            issue = { field: 'rootIri', message: 'Bitte eine Wurzelressource auswählen oder ihre absolute IRI eingeben.' };
        }
        if (issue) { showErrors([issue], false, true); return false; }
        return true;
    }

    async function decodeXmlFile(file) {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let encoding = 'utf-8';
        if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)) encoding = 'utf-16le';
        else if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)) encoding = 'utf-16be';
        else {
            const match = new TextDecoder('ascii').decode(bytes.slice(0, 256)).match(/^\s*<\?xml\s[^?]*encoding\s*=\s*["']([^"']+)["']/i);
            if (match) encoding = match[1];
        }
        return new TextDecoder(encoding, { fatal: true }).decode(buffer)
            .replace(/^(\s*<\?xml\s[^?]*encoding\s*=\s*)["'][^"']+["']/i, '$1"UTF-8"');
    }

    function consumeHandoff() {
        let text;
        try {
            text = sessionStorage.getItem('ddb-edm-converter-handoff-v1');
            if (text !== null) sessionStorage.removeItem('ddb-edm-converter-handoff-v1');
        } catch (_) {
            // Direct entry and manual input also work when browser storage is unavailable.
            return;
        }
        if (text === null) return;
        try {
            const data = JSON.parse(text);
            if (!data || typeof data.rdfXml !== 'string' || !data.rdfXml.trim()) throw new Error();
            documentIri = typeof data.documentIri === 'string' ? data.documentIri : null;
            byId('converterInput').value = data.rdfXml;
            byId('converterBase').value = '';
            byId('converterSource').textContent = documentIri ? 'Dokument-IRI: ' + documentIri : 'Aus der Validierung übernommen.';
            invalidate(true);
            scheduleSaveInput();
            flushSavedInput();
            queueEditor(byId('converterInput'));
            byId('converterInput').focus();
        } catch (_) {
            status('Die übergebene Eingabe konnte nicht übernommen werden. Bitte RDF/XML einfügen oder eine Datei öffnen.', 'warning');
        }
    }

    restoreSavedInput();
    window.addEventListener('pagehide', flushSavedInput);
    document.querySelectorAll('.navbar a').forEach(link => link.addEventListener('click', flushSavedInput));

    form.querySelectorAll('.converter-code-editor textarea').forEach(textarea => {
        textarea.addEventListener('input', () => queueEditor(textarea));
        textarea.addEventListener('scroll', () => {
            const pre = textarea.parentElement.querySelector('pre');
            pre.scrollTop = textarea.scrollTop;
            pre.scrollLeft = textarea.scrollLeft;
        });
        textarea.addEventListener('blur', () => window.requestAnimationFrame(() => {
            const pre = textarea.parentElement.querySelector('pre');
            pre.scrollTop = textarea.scrollTop;
            pre.scrollLeft = textarea.scrollLeft;
        }));
        queueEditor(textarea);
    });

    form.addEventListener('input', event => {
        if (event.target === byId('converterFile')) return;
        const sourceChanged = event.target === byId('converterInput') || event.target === byId('converterBase');
        if (event.target === byId('converterInput')) {
            fileReadToken++;
            fileLoading = false;
            sourceFile = null;
            byId('converterFile').value = '';
        }
        invalidate(sourceChanged);
        if (sourceChanged) scheduleSaveInput();
        syncOptions();
        if (!wantsMetadata()) cancelInspect();
    });

    byId('converterAdvanced').addEventListener('toggle', () => {
        if (byId('converterAdvanced').open) {
            syncOptions();
            scheduleInspect();
        } else cancelInspect();
    });
    byId('converterContextDetails').addEventListener('toggle', () => {
        if (byId('converterContextDetails').open) queueEditor(byId('converterContext'));
    });
    byId('converterAutoContextDetails').addEventListener('toggle', () => {
        if (byId('converterAutoContextDetails').open) sourceText(byId('converterAutoContext'), automaticContext);
    });
    byId('converterFramePreviewDetails').addEventListener('toggle', updateFramePreview);

    byId('converterFile').addEventListener('change', async () => {
        const file = byId('converterFile').files[0];
        if (!file) return;
        const token = ++fileReadToken;
        fileLoading = true;
        sourceFile = null;
        documentIri = null;
        byId('converterInput').value = '';
        removeSavedInput();
        byId('converterSource').textContent = '';
        invalidate(true, false);
        queueEditor(byId('converterInput'));
        if (file.size > maxBytes) {
            fileLoading = false;
            byId('converterFile').value = '';
            setBusy(false);
            showErrors([{ field: 'file', message: 'Die Datei darf höchstens 1 MiB groß sein.' }], false, true);
            return;
        }
        status('Datei wird eingelesen …');
        try {
            const text = await decodeXmlFile(file);
            if (token !== fileReadToken) return;
            fileLoading = false;
            sourceFile = file;
            byId('converterInput').value = text;
            byId('converterSource').textContent = file.name;
            queueEditor(byId('converterInput'));
            invalidate(true);
            scheduleSaveInput();
            flushSavedInput();
        } catch (error) {
            if (token !== fileReadToken) return;
            fileLoading = false;
            byId('converterFile').value = '';
            setBusy(false);
            visible('converterStatus', false);
            showErrors([{ field: 'file', message: 'Die XML-Zeichenkodierung konnte nicht gelesen werden: ' + error.message }], false, true);
        }
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (processing || fileLoading) return;
        flushSavedInput();
        clearErrors();
        const data = requestData();
        if (!checkInput(data)) return;
        cancelInspect();
        convertController?.abort();
        const controller = new AbortController();
        convertController = controller;
        const version = revision;
        const timeout = window.setTimeout(() => controller.abort(), 300000);
        setBusy(true);
        status('Dokument wird konvertiert …');
        hasResult = false;
        byId('converterResults').replaceChildren();
        visible('converterEmptyState', false);
        try {
            const response = await api(sourceFile ? '/upload' : '', data, controller.signal, !!sourceFile);
            if (revision !== version || controller.signal.aborted) return;
            inspectedRevision = sourceRevision;
            metadataIssues = (response.errors || []).filter(issue => ['rdfXml', 'file', 'baseIri', 'documentIri'].includes(issue.field));
            effectiveFrame = response.effectiveFrame || null;
            updateMetadata(response);
            const expectedId = data.jsonLdOutput ? data.methods[0] : 'rdfxml';
            const result = (response.results || []).find(item => item.id === expectedId);
            const issues = [...(response.errors || [])];
            if (result?.error && !issues.some(issue => issue.message === result.error)) {
                issues.push({ field: 'result', message: result.error });
            }
            const firstError = showErrors(issues, false, true);
            const success = renderResult(result);
            visible('converterEmptyState', !success);
            if (issues.length) visible('converterStatus', false);
            else if (success && result.empty) status('Keine passende Ressource gefunden (leeres Trefferergebnis).', 'warning');
            else status(success ? 'Konvertierung abgeschlossen.' : 'Keine Datei erzeugt. Bitte die Eingabe prüfen.', success ? 'success' : 'warning');
            if (success && !firstError) byId('converterOutputPanel').focus();
        } catch (error) {
            if (revision !== version) return;
            visible('converterEmptyState', true);
            status(error.name === 'AbortError' ? 'Die Konvertierung wurde nach fünf Minuten abgebrochen. Bitte die Eingabe verkleinern.' : error.message, 'danger');
        } finally {
            window.clearTimeout(timeout);
            if (convertController === controller) {
                convertController = null;
                if (revision === version) setBusy(false);
            }
        }
    });

    byId('converterReset').addEventListener('click', () => {
        fileReadToken++;
        fileLoading = false;
        removeSavedInput();
        form.reset();
        sourceFile = null;
        documentIri = null;
        frameDraftInitialized = false;
        byId('converterFrame').value = '';
        byId('converterSource').textContent = '';
        for (const id of ['converterAdvanced', 'converterContextDetails', 'converterAutoContextDetails', 'converterFramePreviewDetails']) byId(id).open = false;
        invalidate(true, false);
        visible('converterStatus', false);
        form.querySelectorAll('.converter-code-editor textarea').forEach(queueEditor);
        syncOptions();
        byId('converterInput').focus();
    });
    syncOptions();
    consumeHandoff();
})();
