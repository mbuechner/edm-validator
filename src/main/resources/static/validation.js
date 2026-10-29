/* Validation consumes the shared document; loading a DDB source is a separate action. */
(() => {
    'use strict';
    const byId = id => document.getElementById(id);
    const form = byId('validationForm');
    if (!form || !window.RdfSource) return;
    let busy = false;
    const message = (type, text) => AppMessages.show(byId('result'), type, text);

    function clearResults() {
        for (const id of ['checklist', 'details']) byId(id).classList.add('d-none');
        byId('checklistItems').replaceChildren();
        byId('resultList').replaceChildren();
        byId('details').open = false;
    }

    function resultItem(label, value) {
        const item = document.createElement('li');
        item.className = 'list-group-item d-flex justify-content-between align-items-start gap-3';
        const title = document.createElement('span');
        title.className = 'text-secondary';
        title.textContent = label;
        const content = document.createElement('span');
        content.className = 'text-break text-end';
        content.textContent = value;
        item.append(title, content);
        byId('resultList').append(item);
    }

    function resultBlock(result) {
        const item = document.createElement('li');
        item.className = 'list-group-item';
        const heading = document.createElement('div');
        heading.className = 'd-flex justify-content-between gap-2 mb-2';
        const title = document.createElement('strong');
        title.textContent = (result.section || '') + ' – ' + (result.engine || '');
        const badge = document.createElement('span');
        badge.className = 'badge align-self-start text-bg-' + (result.success ? 'success' : 'danger');
        badge.textContent = result.success ? 'OK' : 'Fehler';
        heading.append(title, badge);
        item.append(heading);
        for (const key of ['originalMessage', 'explanation', 'lineSnippet']) {
            if (!result[key]) continue;
            const text = document.createElement(key === 'explanation' ? 'p' : 'pre');
            text.className = key === 'explanation' ? 'mb-2 text-break' : 'source-code bg-body-tertiary border rounded p-2 overflow-auto';
            if (key !== 'explanation' && window.CodeView) {
                CodeView.render(text, result[key], key === 'lineSnippet' ? 'markup' : 'none');
            } else text.textContent = result[key];
            item.append(text);
        }
        if (result.line || result.column) {
            const position = document.createElement('p');
            position.className = 'small mb-0';
            position.textContent = 'Position: Zeile ' + (result.line ?? '–') + ', Spalte ' + (result.column ?? '–');
            item.append(position);
        }
        if (result.metricValue != null && result.metricLabel) {
            const metric = document.createElement('p');
            metric.className = 'small mb-0';
            metric.textContent = result.metricLabel + ': ' + result.metricValue;
            item.append(metric);
        }
        byId('resultList').append(item);
    }

    function showResults(data) {
        const checks = [['XML-Syntax', data.xmlSyntaxPassed], ['EDM XSD', data.edmXsdPassed],
            ['RDF-Syntax', data.rdfSyntaxPassed], ['SHACL', data.shaclPassed]];
        for (const [label, passed] of checks) {
            const row = document.createElement('li');
            row.className = 'list-group-item d-flex justify-content-between align-items-center gap-3';
            const text = document.createElement('span');
            text.textContent = label;
            const badge = document.createElement('span');
            badge.className = 'badge text-bg-' + (passed ? 'success' : 'danger');
            badge.textContent = passed ? 'OK' : 'Fehlgeschlagen';
            row.append(text, badge);
            byId('checklistItems').append(row);
        }
        byId('checklist').classList.remove('d-none');
        if (data.error) resultItem('Fehler', data.error);
        (data.results || []).forEach(resultBlock);
        if (byId('resultList').childElementCount) {
            byId('details').classList.remove('d-none');
            byId('details').open = !!data.error || (data.results || []).some(result => !result.success);
        }
    }

    RdfSource.subscribe(() => {
        clearResults();
        if (!busy) message('info', 'Die Eingabe wurde geändert. Bitte die Validierung erneut starten.');
    });

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        const source = RdfSource.get();
        if (!source.rdfXml.trim()) {
            message('warning', 'Bitte RDF/XML eingeben oder über eine DDB-URI laden.');
            await RdfSource.reveal();
            byId('rdfXmlInput').focus();
            return;
        }
        const revision = RdfSource.revision();
        const button = form.querySelector('button[type="submit"]');
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 300000);
        busy = true;
        button.disabled = true;
        button.textContent = 'Validierung läuft …';
        form.setAttribute('aria-busy', 'true');
        clearResults();
        message('info', 'RDF/XML wird validiert …');
        try {
            const response = await fetch('./api/validate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
                body: JSON.stringify({ ddbUri: null, rdfXml: source.rdfXml, europeanaProfile: false,
                    documentIri: source.documentIri })
            });
            const text = await response.text();
            if (revision !== RdfSource.revision()) return;
            if (!response.ok) throw new Error('HTTP ' + response.status + (text.trim().startsWith('<') ? ': Server lieferte HTML.' : ''));
            let data;
            try { data = JSON.parse(text); } catch (_) { throw new Error('Backend lieferte keine gültige JSON-Antwort.'); }
            if (!data) throw new Error('Backend lieferte keine Validierungsergebnisse.');
            message(data.overallPassed ? 'success' : 'warning', data.message || 'Validierung abgeschlossen.');
            showResults(data);
        } catch (error) {
            if (revision === RdfSource.revision()) message('danger', error.name === 'AbortError'
                ? 'Fehler: Die Validierung hat das Zeitlimit von 300 Sekunden überschritten.' : 'Fehler: ' + error.message);
        } finally {
            window.clearTimeout(timer);
            busy = false;
            button.disabled = false;
            button.textContent = 'Validierung starten';
            form.removeAttribute('aria-busy');
            if (revision !== RdfSource.revision()) message('info', 'Die Eingabe wurde geändert. Bitte die Validierung erneut starten.');
        }
    });
})();
