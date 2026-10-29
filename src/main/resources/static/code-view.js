/* Read-only source views: exact text, optional Prism tokens and decorative line numbers. */
(() => {
    'use strict';
    const views = new WeakMap();
    const highlightLimit = 200_000;
    const virtualLineLimit = 5_000;
    const languageName = language => {
        const name = typeof language === 'string' ? language.toLowerCase() : 'none';
        return name === 'xml' ? 'markup' : /^[\w-]+$/.test(name) ? name : 'none';
    };

    function lineCount(text) {
        let count = 1;
        for (let index = 0; index < text.length; index++) {
            if (text[index] === '\r') {
                count++;
                if (text[index + 1] === '\n') index++;
            } else if (text[index] === '\n') count++;
        }
        return count;
    }

    /** Build Prism's public token tree with text nodes, preserving CRLF and nonbreaking spaces. */
    function appendTokens(parent, tokens) {
        if (typeof tokens === 'string') { parent.append(document.createTextNode(tokens)); return; }
        if (Array.isArray(tokens)) { tokens.forEach(token => appendTokens(parent, token)); return; }
        const span = document.createElement('span');
        span.classList.add('token');
        for (const name of [tokens.type, ...(Array.isArray(tokens.alias) ? tokens.alias : [tokens.alias])]) {
            if (typeof name === 'string' && /^[\w-]+$/.test(name)) span.classList.add(name);
        }
        appendTokens(span, tokens.content);
        parent.append(span);
    }

    function highlight(code, text, language = 'none') {
        const value = typeof text === 'string' ? text : String(text ?? '');
        const mode = languageName(language);
        code.className = 'language-' + mode;
        code.textContent = value;
        const grammar = window.Prism?.languages?.[mode];
        if (value.length > highlightLimit || !grammar || typeof window.Prism?.tokenize !== 'function') return false;
        try {
            const fragment = document.createDocumentFragment();
            appendTokens(fragment, window.Prism.tokenize(value, grammar));
            code.replaceChildren(fragment);
            if (code.textContent === value) return true;
        } catch (_) { /* An optional highlighter must never make the source unusable. */ }
        code.textContent = value;
        return false;
    }

    function drawNumbers(pre) {
        const view = views.get(pre);
        if (!view) return;
        const style = window.getComputedStyle(view.code);
        const fontSize = style.fontSize.endsWith('px') ? parseFloat(style.fontSize) : 12;
        const height = style.lineHeight.endsWith('px') ? parseFloat(style.lineHeight)
            : (parseFloat(style.lineHeight) || 1.4) * fontSize;
        const topPadding = parseFloat(style.paddingTop) || 12;
        const bottomPadding = parseFloat(style.paddingBottom) || 12;
        // CSS gives a trailing empty source line its own space without appending a character.
        view.code.style.minHeight = (view.count * height + topPadding + bottomPadding) + 'px';
        const virtual = view.count > virtualLineLimit;
        const first = virtual ? Math.min(view.count - 1,
            Math.max(0, Math.floor(Math.max(0, pre.scrollTop - topPadding) / height) - 10)) : 0;
        const visibleCount = virtual ? Math.max(60, Math.ceil((pre.clientHeight || 600) / height) + 20) : view.count;
        const end = Math.min(view.count, first + visibleCount);
        if (view.first === first && view.end === end && view.height === height) return;
        view.first = first;
        view.end = end;
        view.height = height;
        const numbers = [];
        for (let index = first + 1; index <= end; index++) numbers.push(index);
        view.gutter.dataset.lines = numbers.join('\n');
        view.gutter.style.setProperty('--code-view-number-offset', (first * height) + 'px');
    }

    /** Render a complete source without inserting line numbers into its selectable content. */
    function render(pre, text, language = 'none') {
        const value = typeof text === 'string' ? text : String(text ?? '');
        const mode = languageName(language);
        let view = views.get(pre);
        if (!view || !pre.contains(view.code) || !pre.contains(view.gutter)) {
            const code = [...pre.children].find(child => child.tagName === 'CODE') || document.createElement('code');
            const gutter = document.createElement('span');
            gutter.className = 'code-view-gutter';
            gutter.setAttribute('aria-hidden', 'true');
            pre.replaceChildren(gutter, code);
            view = { code, gutter, text: null, language: null };
            if (!views.has(pre)) pre.addEventListener('scroll', () => drawNumbers(pre), { passive: true });
            views.set(pre, view);
        }
        pre.classList.add('code-view', 'source-code');
        if (!pre.hasAttribute('tabindex')) pre.tabIndex = 0;
        view.code.className = 'language-' + mode;
        const grammar = window.Prism?.languages?.[mode] || null;
        if (view.text !== value || view.language !== mode || view.grammar !== grammar) {
            highlight(view.code, value, mode);
            view.text = value;
            view.language = mode;
            view.grammar = grammar;
            view.count = lineCount(value);
            view.first = null;
            pre.dataset.lineCount = String(view.count);
            pre.style.setProperty('--code-view-gutter-width', (String(view.count).length + 2) + 'ch');
        }
        drawNumbers(pre);
        if (view.frame == null) {
            // Callers may append the pre only after rendering it; then font and viewport metrics change.
            const afterInsertion = () => {
                view.frame = null;
                if (pre.isConnected) drawNumbers(pre);
            };
            view.frame = typeof window.requestAnimationFrame === 'function'
                ? window.requestAnimationFrame(afterInsertion) : window.setTimeout(afterInsertion, 0);
        }
        return view.code;
    }

    window.CodeView = Object.freeze({ render, highlight });
})();
