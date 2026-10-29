/* One document in, one document out. Advanced RDF settings are optional. */
(() => {
    'use strict';
    const byId = id => document.getElementById(id);
    const form = byId('converterForm');
    if (!form) return;
    const maxBytes = 1024 * 1024;
    const highlightLimit = 200_000;
    const labels = {
        compacted: 'JSON-LD · Kompakt',
        expanded: 'JSON-LD · Expandiert'
    };
    const hints = {
        compacted: 'Kurze Bezeichner mit automatisch erzeugtem Kontext.',
        expanded: 'Vollständige IRIs und explizite Werte.'
    };
    const structureHints = {
        standard: 'Den vollständigen RDF-Graphen ausgeben.',
        flattened: 'Jede Ressource als eigenen Knoten ausgeben.',
        framed: 'Eine Ressource mit ihren Verknüpfungen ausgeben.'
    };
    const xmlRepresentationHints = {
        explicit: 'Ressourcen mit rdf:Description und explizitem rdf:type.',
        typed: 'Ressourcen mit typisierten XML-Elementen; sonst explizites rdf:type.'
    };
    const xmlStructureHints = {
        flat: 'Ressourcen direkt unter rdf:RDF auflisten.',
        nested: 'Der Writer verschachtelt Ressourcen, soweit möglich. Gemeinsam genutzte oder zyklisch verknüpfte Knoten können Referenzen bleiben.'
    };
    const editors = new Map();
    let revision = 0;
    let sourceRevision = 0;
    let inspectedRevision = -1;
    let inspectingRevision = -1;
    let metadataIssues = [];
    let frameDraftInitialized = false;
    let processing = false;
    let hasResult = false;
    let convertController = null;
    let inspectController = null;
    let inspectTimer = null;

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
        byId('converterSubmit').disabled = busy;
        byId('converterSubmit').textContent = busy ? 'Wird konvertiert …' : 'Konvertieren';
        byId('converterOutputPanel').setAttribute('aria-busy', String(busy));
    }

    function clearErrors() {
        for (const id of ['converterInputError', 'converterBaseError',
            'converterFrameError', 'converterOutputError', 'converterErrors']) byId(id).textContent = '';
        visible('converterErrors', false);
        byId('rdfXmlInput').removeAttribute('aria-invalid');
        for (const element of form.querySelectorAll('[aria-invalid]')) element.removeAttribute('aria-invalid');
    }

    function reveal(element) {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (parent.tagName === 'DETAILS') parent.open = true;
        }
    }

    function showErrors(issues, metadataOnly = false, focus = false) {
        const targets = {
            rdfXml: ['converterInputError', 'rdfXmlInput'],
            file: ['converterInputError', 'rdfXmlInput'],
            baseIri: ['converterBaseError', 'converterBase'],
            documentIri: ['converterBaseError', 'converterBase'],
            context: ['converterOutputError', 'converterJsonLd'],
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
        if (focus && first) {
            if (first.closest('#rdfSource')) window.RdfSource.reveal().then(() => first.focus());
            else first.focus();
        }
        return first;
    }

    function generatedFrame() {
        const frame = { '@embed': selected('converterEmbed') };
        const root = byId('converterRoot').value.trim();
        if (root) frame['@id'] = root;
        return frame;
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
        byId('converterOutputSummary').textContent = json ? jsonLabel() : xmlLabel();
        byId('converterXmlRepresentationHint').textContent = xmlRepresentationHints[xmlRepresentation()];
        byId('converterXmlStructureHint').textContent = xmlStructureHints[xmlStructure()];
        visible('converterFrameOptions', framed);
        const customFrame = selected('converterFrameMode') === 'custom';
        if (framed && customFrame && !frameDraftInitialized) {
            byId('converterFrame').value = JSON.stringify(generatedFrame(), null, 2);
            frameDraftInitialized = true;
            queueEditor(byId('converterFrame'));
        }
        byId('converterFrameFields').disabled = customFrame;
        byId('converterRoot').setAttribute('aria-required', String(framed && !customFrame));
        visible('converterFrameEditorBox', customFrame);
        if (isVisible(byId('converterFrame'))) queueEditor(byId('converterFrame'));
    }

    function modelInput() {
        return {
            rdfXml: window.RdfSource.get().rdfXml,
            baseIri: byId('converterBase').value.trim() || null,
            documentIri: window.RdfSource.get().documentIri
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
            methods: [method()], representation: representation(), contextMode: 'generated'
        };
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
        return byId('converterAdvanced').open && isJson() && structure() === 'framed'
            && byId('rdfXmlInput').value.trim();
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
            metadataIssues = [];
            byId('converterResources').replaceChildren();
        } else showErrors(metadataIssues, true);
        if (previousResult) status('Eingabe oder Einstellungen geändert. Bitte erneut konvertieren.');
        else visible('converterStatus', false);
        if (schedule) scheduleInspect();
    }

    function updateMetadata(data) {
        if (Array.isArray(data.resources)) {
            byId('converterResources').replaceChildren(...data.resources.map(iri => {
                const option = document.createElement('option');
                option.value = iri;
                return option;
            }));
        }
    }

    async function api(path, data, signal) {
        const options = { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data) };
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
        if (new TextEncoder().encode(byId('rdfXmlInput').value).length > maxBytes) return;
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
        range.selectNodeContents(source.querySelector('code') || source);
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
            pre.className = 'source-code border rounded bg-body-tertiary p-3 mb-0 overflow-auto font-monospace focus-ring';
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
            window.CodeView.render(pre, item.content, item.id === 'rdfxml' ? 'markup' : 'json');
            hasResult = true;
        }
        byId('converterResults').append(article);
        return hasResult;
    }

    function checkInput(data) {
        let issue;
        if (!data.rdfXml.trim()) issue = { field: 'rdfXml', message: 'Bitte RDF/XML einfügen oder eine Datei hochladen.' };
        else if (new TextEncoder().encode(data.rdfXml).length > maxBytes) {
            issue = { field: 'rdfXml', message: 'Die Eingabe darf höchstens 1 MiB groß sein.' };
        } else if (data.jsonLdOutput && method() === 'framed' && data.frameMode !== 'custom' && !data.rootIri) {
            issue = { field: 'rootIri', message: 'Bitte eine Wurzelressource auswählen oder ihre absolute IRI eingeben.' };
        }
        if (issue) { showErrors([issue], false, true); return false; }
        return true;
    }

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

    // Every tool observes the same source; changing it invalidates stale outputs and requests.
    let previousDocumentIri = window.RdfSource.get().documentIri;
    window.RdfSource.subscribe(source => {
        if (source.documentIri !== previousDocumentIri) byId('converterBase').value = '';
        previousDocumentIri = source.documentIri;
        invalidate(true);
        syncOptions();
    });

    form.addEventListener('input', event => {
        invalidate(event.target === byId('converterBase'));
        syncOptions();
        if (!wantsMetadata()) cancelInspect();
    });

    byId('converterAdvanced').addEventListener('toggle', () => {
        if (byId('converterAdvanced').open) {
            syncOptions();
            scheduleInspect();
        } else cancelInspect();
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (processing) return;
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
            const response = await api('', data, controller.signal);
            if (revision !== version || controller.signal.aborted) return;
            inspectedRevision = sourceRevision;
            metadataIssues = (response.errors || []).filter(issue => ['rdfXml', 'file', 'baseIri', 'documentIri'].includes(issue.field));
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
        const baseChanged = byId('converterBase').value !== '';
        form.reset();
        frameDraftInitialized = false;
        byId('converterFrame').value = '';
        for (const id of ['converterAdvanced']) byId(id).open = false;
        invalidate(baseChanged, false);
        visible('converterStatus', false);
        form.querySelectorAll('.converter-code-editor textarea').forEach(queueEditor);
        syncOptions();
        byId('converterJsonLd').focus();
    });
    syncOptions();
})();
