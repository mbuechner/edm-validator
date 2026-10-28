/* Shared Bootstrap alerts. The host survives dismissal so later messages work. */
(() => {
    'use strict';
    const severities = new Set(['success', 'info', 'warning', 'danger']);

    function show(host, severity, message) {
        if (!host) return;
        const type = severities.has(severity) ? severity : 'info';
        const alert = document.createElement('div');
        alert.className = 'alert alert-' + type + ' alert-dismissible fade show mb-3';
        const urgent = type === 'danger' || type === 'warning';
        alert.setAttribute('role', urgent ? 'alert' : 'status');
        alert.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
        alert.setAttribute('aria-atomic', 'true');
        let content;
        if (typeof message === 'string' && /[\r\n]/.test(message)) {
            content = document.createElement('div');
            content.className = 'd-grid gap-1';
            message.split(/\r\n|\r|\n/).forEach((line, index) => {
                const paragraph = document.createElement('p');
                paragraph.className = 'mb-0 text-break' + (index === 0 ? ' fw-semibold' : '');
                paragraph.textContent = line;
                content.append(paragraph);
            });
        } else {
            content = document.createElement('span');
            content.textContent = message;
        }
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn-close';
        close.setAttribute('data-bs-dismiss', 'alert');
        close.setAttribute('aria-label', 'Meldung schließen');
        const hideEmptyHost = () => {
            if (!host.firstElementChild) host.classList.add('d-none');
        };
        alert.addEventListener('closed.bs.alert', hideEmptyHost);
        close.addEventListener('click', () => {
            if (!window.bootstrap?.Alert) {
                alert.remove();
                hideEmptyHost();
            }
        });
        alert.append(content, close);
        host.removeAttribute('role');
        host.removeAttribute('aria-live');
        host.removeAttribute('aria-atomic');
        host.replaceChildren(alert);
        host.classList.remove('d-none');
    }

    window.AppMessages = { show };
})();
