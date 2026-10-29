// Optional DOM tests: npm install --no-save --prefix target/ui-check jsdom@26.1.0
// Run: node --test src/test/js/source-editor.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
let JSDOM;
try { ({ JSDOM } = require(path.join(root, 'target/ui-check/node_modules/jsdom'))); }
catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    test('Shared XML editor DOM tests', { skip: 'Install optional test tools: jsdom@26.1.0 in target/ui-check' }, () => {});
}

if (JSDOM) {
    const read = name => fs.readFileSync(path.join(root, 'src/main/resources/static', name), 'utf8');
    const sourceScript = read('rdf-source.js');
    const codeViewScript = read('code-view.js');
    const stylesheet = read('source.css');
    const prismScripts = ['vendor/prism-core-1.29.0.min.js', 'vendor/prism-markup-1.29.0.min.js'].map(read);
    const key = 'ddb-rdf-source-v1';
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n\t<name>München &amp; Straße</name>\n</rdf:RDF>\n';
    const settled = () => new Promise(resolve => setImmediate(resolve));
    const transparent = color => color === 'transparent' || /^rgba\([^)]*,\s*0(?:\.0*)?\)$/.test(color);
    function deferred() {
        let resolve;
        const promise = new Promise(yes => { resolve = yes; });
        return { promise, resolve };
    }

    function harness(t, options = {}) {
        const dom = new JSDOM('<main><section id="rdfSource"></section></main>', {
            url: 'https://validator.example/app/', runScripts: 'outside-only'
        });
        const { window } = dom;
        const { document } = window;
        window.TextDecoder = TextDecoder;
        if (options.saved !== undefined) window.localStorage.setItem(key, JSON.stringify({ rdfXml: options.saved, ddbUri: '', documentIri: null }));
        const style = document.createElement('style');
        style.textContent = stylesheet;
        document.head.append(style);
        // JSDOM does not implement forced-colors matching. Apply the selected, actual
        // CSS media branch so cascade/metric assertions still exercise our stylesheet.
        const mediaStyle = document.createElement('style');
        mediaStyle.textContent = [...style.sheet.cssRules]
            .filter(rule => rule.media?.mediaText === '(forced-colors: ' + (options.forcedColors ? 'active' : 'none') + ')')
            .flatMap(rule => [...rule.cssRules].map(child => child.cssText)).join('\n');
        document.head.append(mediaStyle);
        const timers = new Map(), observers = [], events = [], calls = [];
        let timerId = 0;
        window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
        window.clearTimeout = id => timers.delete(id);
        window.ResizeObserver = class {
            constructor(callback) { this.callback = callback; observers.push(this); }
            observe(element) { this.element = element; }
        };
        window.fetch = (url, config) => {
            calls.push({ url, ...config });
            return options.fetch ? options.fetch(url, config) : Promise.resolve({ ok: true, json: async () => ({ rdfXml: xml, apiUrl: 'https://example.org/source.rdf' }) });
        };
        document.addEventListener('rdf-source-change', event => events.push(event.detail));
        if (options.prism !== false) {
            window.Prism = { manual: true };
            for (const script of prismScripts) window.eval(script);
        }
        if (options.codeView !== false) window.eval(codeViewScript);
        window.eval(sourceScript);
        const get = id => document.getElementById(id);
        const input = get('rdfXmlInput');
        const editor = get('rdfSourceEditor');
        const pre = editor.querySelector('pre');
        const code = pre.querySelector('code');
        const type = text => {
            input.value = text;
            input.dispatchEvent(new window.Event('input', { bubbles: true }));
        };
        const paint = () => {
            for (const [id, timer] of [...timers]) {
                if (timer.delay > 1000) continue; // Source fetch timeouts are separate operations.
                timers.delete(id);
                timer.callback();
            }
        };
        t.after(() => window.close());
        return { window, document, get, input, editor, pre, code, type, paint, timers, observers, events, calls,
            api: window.RdfSource, style: element => window.getComputedStyle(element) };
    }

    test('real Prism highlights XML while the native focused textarea keeps its selection and exact source', t => {
        const app = harness(t);
        app.input.focus();
        app.type(xml);
        app.input.setSelectionRange(12, 39, 'backward');
        const revision = app.api.revision();
        assert.equal(app.editor.classList.contains('rdf-source-highlighted'), false, 'new input is readable immediately while highlighting waits');
        assert.equal(transparent(app.style(app.input).color), false);
        app.paint();
        assert.equal(app.editor.classList.contains('rdf-source-highlighted'), true);
        assert.ok(app.code.querySelector('.token.tag'));
        assert.ok(app.code.querySelector('.token.attr-name'));
        assert.equal(app.document.activeElement, app.input);
        assert.equal(app.input.selectionStart, 12);
        assert.equal(app.input.selectionEnd, 39);
        assert.equal(app.input.selectionDirection, 'backward');
        assert.equal(app.input.value, xml);
        assert.equal(app.api.get().rdfXml, xml);
        assert.equal(app.api.revision(), revision, 'rendering does not invalidate tool results');
        assert.equal(app.style(app.pre).display, 'block');
        assert.equal(transparent(app.style(app.input).color), true);
        assert.equal(transparent(app.style(app.input).caretColor), false, 'the focused editor still has a visible caret');
        assert.equal(app.pre.getAttribute('aria-hidden'), 'true');
        assert.equal(app.style(app.pre).pointerEvents, 'none');
        assert.equal(app.style(app.pre).userSelect, 'none');
    });

    test('XML markup and Unicode stay text, including an empty final line and hostile element names', t => {
        const app = harness(t);
        const source = '<root title="Grüße &amp; München"><script>alert(1)</script><img src="x"/>\n\tStraße 😀</root>\n';
        app.type(source);
        app.paint();
        assert.equal(app.code.querySelector('script,img,root'), null, 'source elements cannot become active HTML');
        assert.equal(app.code.textContent, source + ' ', 'the mirror retains the final empty line');
        app.input.setSelectionRange(0, source.length);
        assert.equal(app.input.value.slice(app.input.selectionStart, app.input.selectionEnd), source, 'native copy contains only the original XML');
        app.type('');
        app.paint();
        assert.equal(app.code.textContent, '');
        assert.equal(app.input.value, '');
        assert.equal(app.editor.classList.contains('rdf-source-highlighted'), false);
        assert.equal(transparent(app.style(app.input).color), false);
    });

    test('native viewport, padding, fonts and scroll positions stay aligned through resize and accordion opening', async t => {
        const app = harness(t, { saved: xml });
        let width = 730, height = 210;
        Object.defineProperties(app.input, {
            clientWidth: { get: () => width }, clientHeight: { get: () => height }
        });
        app.input.style.borderWidth = '2px';
        app.paint();
        app.input.scrollTop = 84;
        app.input.scrollLeft = 57;
        app.input.dispatchEvent(new app.window.Event('scroll'));
        assert.equal(app.pre.scrollTop, 84);
        assert.equal(app.pre.scrollLeft, 57);
        assert.equal(app.pre.style.width, '730px');
        assert.equal(app.pre.style.height, '210px');
        assert.equal(app.pre.style.left, '2px');
        assert.equal(app.pre.style.top, '2px');
        for (const property of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'whiteSpace', 'tabSize', 'padding']) {
            assert.equal(app.style(app.pre)[property], app.style(app.input)[property], property);
        }
        assert.equal(app.input.wrap, 'off');
        assert.equal(app.input.rows, 12);
        assert.equal(app.style(app.input).position, 'relative', 'native textarea sizing remains in normal flow');
        assert.equal(app.style(app.input).resize, 'vertical');
        width = 500;
        height = 330;
        assert.equal(app.observers[0].element, app.input);
        app.observers[0].callback();
        assert.equal(app.pre.style.height, '330px');
        await app.api.reveal();
        app.paint();
        assert.equal(app.pre.style.width, '500px');
        assert.equal(app.pre.scrollLeft, 57);
        assert.equal(app.pre.scrollTop, 84);
    });

    test('scrolling the editor synchronizes offsets without repeatedly measuring layout', t => {
        const app = harness(t);
        app.type(xml);
        app.paint();
        let measurements = 0;
        const getStyle = app.window.getComputedStyle;
        app.window.getComputedStyle = (...args) => { measurements++; return getStyle(...args); };
        for (let index = 0; index < 100; index++) {
            app.input.scrollTop = index * 2;
            app.input.scrollLeft = index;
            app.input.dispatchEvent(new app.window.Event('scroll'));
        }
        assert.equal(measurements, 0);
        assert.equal(app.pre.scrollTop, 198);
        assert.equal(app.pre.scrollLeft, 99);
    });

    test('stale scheduled highlights never replace or hide newer edits', t => {
        const app = harness(t);
        app.type('<old/>');
        const oldTimer = [...app.timers.values()].find(timer => timer.delay < 1000).callback;
        app.type('<new title="München"/>');
        assert.equal(app.code.textContent, '<new title="München"/>');
        oldTimer(); // A callback already queued by the browser can outlive clearTimeout.
        assert.equal(app.editor.classList.contains('rdf-source-highlighted'), false);
        assert.equal(app.code.textContent, '<new title="München"/>');
        app.paint();
        assert.equal(app.code.textContent, '<new title="München"/>');
        assert.equal(app.editor.classList.contains('rdf-source-highlighted'), true);
    });

    test('programmatic, storage and DDB changes refresh the mirror without synthetic source events', async t => {
        const app = harness(t, { saved: '<restored/>' });
        const initialRevision = app.api.revision();
        app.paint();
        assert.equal(app.code.textContent, '<restored/>');
        assert.equal(app.api.revision(), initialRevision);
        app.api.set({ rdfXml: '<programmatic/>' });
        const afterSet = app.api.revision();
        app.paint();
        assert.equal(app.code.textContent, '<programmatic/>');
        assert.equal(app.api.revision(), afterSet);
        app.window.dispatchEvent(new app.window.StorageEvent('storage', { key,
            newValue: JSON.stringify({ rdfXml: '<other-tab/>', ddbUri: '', documentIri: null }) }));
        app.paint();
        assert.equal(app.code.textContent, '<other-tab/>');
        app.get('ddbUri').value = 'https://ddb.example/item';
        app.get('loadDdbBtn').click();
        await settled();
        const afterLoad = app.api.revision();
        app.paint();
        assert.equal(app.code.textContent, xml + ' ');
        assert.equal(app.api.revision(), afterLoad);
        assert.equal(app.input.value, xml);
    });

    test('a late DDB response cannot restore old highlighting over a newer XML edit', async t => {
        const pending = deferred();
        const app = harness(t, { fetch: () => pending.promise });
        app.get('ddbUri').value = 'https://ddb.example/item';
        app.get('loadDdbBtn').click();
        app.type('<latest>Grüße</latest>');
        app.paint();
        pending.resolve({ ok: true, json: async () => ({ rdfXml: '<late/>', apiUrl: 'https://example.org/late.rdf' }) });
        await settled();
        app.paint();
        assert.equal(app.code.textContent, '<latest>Grüße</latest>');
        assert.equal(app.input.value, '<latest>Grüße</latest>');
        assert.equal(app.api.get().rdfXml, '<latest>Grüße</latest>');
    });

    test('missing or failing Prism and large documents retain readable native text', t => {
        for (const mode of ['missing', 'throws', 'large']) {
            const app = harness(t, { prism: mode !== 'missing' });
            if (mode === 'throws') app.window.Prism.highlight = app.window.Prism.tokenize = () => { throw new Error('Parser failed'); };
            if (mode === 'large') app.window.Prism.highlight = app.window.Prism.tokenize = () => assert.fail('Large input must avoid synchronous tokenization');
            const source = mode === 'large' ? '<root>' + 'x'.repeat(200001) + '</root>' : xml;
            app.input.focus();
            app.type(source);
            app.paint();
            assert.equal(app.input.value, source, mode);
            assert.equal(app.editor.classList.contains('rdf-source-highlighted'), false, mode);
            assert.equal(app.style(app.pre).display, 'none', mode);
            assert.equal(transparent(app.style(app.input).color), false, mode);
            assert.equal(transparent(app.style(app.input).caretColor), false, mode);
        }
    });

    test('input method composition stays native until completion and forced colors preserve text visibility', t => {
        const app = harness(t);
        app.type('<name/>');
        app.paint();
        app.input.dispatchEvent(new app.window.CompositionEvent('compositionstart'));
        app.type('<name>München</name>');
        app.paint();
        assert.equal(app.editor.classList.contains('rdf-source-highlighted'), false);
        assert.equal(transparent(app.style(app.input).color), false);
        app.input.dispatchEvent(new app.window.CompositionEvent('compositionend'));
        app.paint();
        assert.equal(app.editor.classList.contains('rdf-source-highlighted'), true);
        const accessible = harness(t, { forcedColors: true });
        accessible.type(xml);
        accessible.paint();
        assert.equal(accessible.style(accessible.pre).display, 'none');
        assert.equal(transparent(accessible.style(accessible.input).color), false);
        assert.equal(transparent(accessible.style(accessible.input).caretColor), false);
    });

    test('shared token rendering preserves nonbreaking spaces and an absent helper still falls back safely', t => {
        const app = harness(t);
        const source = '<title>München\u00a0–\u00a0Straße</title>';
        app.type(source);
        app.paint();
        assert.equal(app.code.textContent, source);
        assert.equal(app.editor.classList.contains('rdf-source-highlighted'), true);
        const fallback = harness(t, { codeView: false });
        fallback.type('<title>Grüße</title>');
        fallback.paint();
        assert.equal(fallback.editor.classList.contains('rdf-source-highlighted'), true, 'ordinary XML works with Prism alone');
        fallback.type(source);
        fallback.paint();
        assert.equal(fallback.input.value, source);
        assert.equal(fallback.code.textContent, source);
        assert.equal(fallback.editor.classList.contains('rdf-source-highlighted'), false, 'normalized whitespace never hides the original text');
        assert.equal(transparent(fallback.style(fallback.input).color), false);
    });
}
