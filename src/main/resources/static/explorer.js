/* Builds a preview directly from the shared source, independently of validation. */
(() => {
    'use strict';
    const form = document.getElementById('explorerForm');
    if (!form || !window.RdfSource) return;
    const button = document.getElementById('renderGraphBtn');
    const message = (type, text) => AppMessages.show(document.getElementById('result'), type, text);
    let pending = null;

    function finish(request) {
        if (pending !== request) return;
        window.clearTimeout(request.timer);
        pending = null;
        button.disabled = false;
        form.removeAttribute('aria-busy');
    }

    function cancel() {
        if (!pending) return;
        const request = pending;
        finish(request);
        request.controller.abort();
    }

    async function render() {
        if (pending) return;
        const source = RdfSource.get();
        if (!source.rdfXml.trim()) {
            message('info', 'Bitte RDF/XML eingeben oder über eine DDB-URI laden und anschließend den Graph anzeigen.');
            await RdfSource.reveal();
            return;
        }
        const revision = RdfSource.revision();
        const controller = new AbortController();
        const request = { controller, timer: null };
        pending = request;
        request.timer = window.setTimeout(() => {
            if (pending !== request) return;
            cancel();
            message('danger', 'Die Graph-Anfrage hat das Zeitlimit überschritten. Bitte erneut versuchen.');
        }, 30000);
        button.disabled = true;
        form.setAttribute('aria-busy', 'true');
        RdfGraphExplorer.hide();
        message('info', 'Graph wird vorbereitet …');
        try {
            const response = await fetch('./api/graph', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
                body: JSON.stringify({ rdfXml: source.rdfXml, documentIri: source.documentIri })
            });
            const data = await response.json();
            if (pending !== request || revision !== RdfSource.revision()) return;
            if (!response.ok || data.error) throw new Error(data.error || 'HTTP ' + response.status);
            if (!data.graphNodes?.length || !data.graphLinks?.length) {
                message('info', 'Das Dokument enthält keine darstellbaren RDF-Verbindungen.');
                return;
            }
            await RdfGraphExplorer.render(data);
            if (pending !== request || revision !== RdfSource.revision()) return;
            // The graph reports renderer readiness and failures inside its own panel.
            const status = document.getElementById('result');
            status.replaceChildren();
            status.classList.add('d-none');
        } catch (error) {
            if (pending === request && revision === RdfSource.revision()) message('danger', error.name === 'AbortError'
                ? 'Die Graph-Anfrage wurde abgebrochen oder hat das Zeitlimit überschritten.' : 'Graph konnte nicht geladen werden: ' + error.message);
        } finally {
            finish(request);
        }
    }

    RdfSource.subscribe(() => {
        cancel();
        RdfGraphExplorer.hide();
        message('info', 'Die Eingabe wurde geändert. Bitte den Graph erneut anzeigen.');
    });
    window.addEventListener('pagehide', cancel);
    form.addEventListener('submit', event => { event.preventDefault(); render(); });
    // A saved document is ready to explore immediately when this page is opened.
    render();
})();
