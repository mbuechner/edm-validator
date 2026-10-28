/* Pass the displayed document once when navigating to the separate converter page. */
(() => {
    'use strict';
    const link = document.getElementById('convertDisplayedXml');
    if (!link) return;

    link.addEventListener('click', event => {
        const rdfXml = document.getElementById('xmlCode')?.textContent || '';
        if (!rdfXml.trim()) {
            event.preventDefault();
            return;
        }
        try {
            const documentIri = typeof lastValidationData !== 'undefined' ? lastValidationData?.apiUrl || null : null;
            sessionStorage.setItem('ddb-edm-converter-handoff-v1', JSON.stringify({ rdfXml, documentIri }));
        } catch (_) {
            event.preventDefault();
            const message = 'Das Dokument konnte nicht an den Konverter übergeben werden. Bitte RDF/XML kopieren und dort einfügen.';
            if (typeof setResult === 'function') setResult('danger', message);
            else {
                let error = document.getElementById('converterNavigationError');
                if (!error) {
                    error = document.createElement('p');
                    error.id = 'converterNavigationError';
                    error.className = 'alert alert-danger mt-2';
                    error.setAttribute('role', 'alert');
                    link.insertAdjacentElement('afterend', error);
                }
                error.textContent = message;
            }
        }
    });
})();
