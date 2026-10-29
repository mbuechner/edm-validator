// Run: node --test src/test/js/code-view.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const assets = path.join(root, 'src/main/resources/static');
let JSDOM;
try {
    ({JSDOM} = require(path.join(root, 'target/ui-check/node_modules/jsdom')));
} catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    test('Code view DOM tests', {skip: 'Install jsdom under target/ui-check to run DOM tests.'}, () => {});
}

if (JSDOM) {
    const script = fs.readFileSync(path.join(assets, 'code-view.js'), 'utf8');
    const css = fs.readFileSync(path.join(assets, 'code-view.css'), 'utf8');
    function prism(window) {
        window.Prism = {manual: true};
        for (const file of ['prism-core-1.29.0.min.js', 'prism-markup-1.29.0.min.js', 'prism-json-1.29.0.min.js']) {
            window.eval(fs.readFileSync(path.join(assets, 'vendor', file), 'utf8'));
        }
    }
    function harness(t, withPrism = true) {
        const dom = new JSDOM('<style></style><pre id="output"></pre>', {
            runScripts: 'outside-only', url: 'https://validator.example/', pretendToBeVisual: true
        });
        const {window} = dom;
        window.document.querySelector('style').textContent = css;
        const pre = window.document.getElementById('output');
        pre.style.fontSize = '12px';
        pre.style.lineHeight = '1.4';
        if (withPrism) prism(window);
        window.eval(script);
        t.after(() => window.close());
        return {window, pre, render: (text, language) => window.CodeView.render(pre, text, language)};
    }

    test('real Prism colors XML and JSON while keeping source characters and all line endings exact', t => {
        const app = harness(t);
        for (const [language, text] of [
            ['markup', '<rdf:RDF xmlns:rdf="urn:rdf">\r\n  <rdf:Description>\u00a0&amp; value</rdf:Description>\r\n</rdf:RDF>\r\n'],
            ['json', '{\r\n  "name": "München\u00a0& Straße",\r\n  "value": true\r\n}\r\n']
        ]) {
            const code = app.render(text, language);
            assert.equal(code.textContent, text);
            assert.equal(app.pre.textContent, text, 'decorative line numbers create no selectable text nodes');
            assert.ok(code.querySelector('.token'), language + ' has actual Prism tokens');
            assert.equal(app.pre.dataset.lineCount, String(text.split(/\r\n|\r|\n/).length));
        }
    });

    test('empty sources, mixed newline styles and a trailing empty line have consistent numbers', t => {
        const app = harness(t, false);
        for (const [text, count] of [['', 1], ['one', 1], ['one\n', 2], ['one\r\ntwo\rthree\nfour\n', 5]]) {
            const code = app.render(text);
            const gutter = app.pre.querySelector('.code-view-gutter');
            assert.equal(code.textContent, text);
            assert.equal(app.pre.dataset.lineCount, String(count));
            assert.equal(gutter.dataset.lines, Array.from({length: count}, (_, index) => index + 1).join('\n'));
            assert.equal(gutter.textContent, '');
            assert.equal(gutter.getAttribute('aria-hidden'), 'true');
        }
    });

    test('untrusted output remains literal text and line numbers never enter selected output', t => {
        const app = harness(t);
        const text = '<img src=x onerror=alert(1)>\r\n<script>alert("unsafe")</script>\n';
        const code = app.render(text, 'markup');
        assert.equal(code.textContent, text);
        assert.equal(app.pre.querySelector('img, script'), null);
        for (const selected of [code, app.pre]) {
            const range = app.window.document.createRange();
            range.selectNodeContents(selected);
            const selection = app.window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            assert.equal(selection.toString(), text);
        }
        const gutter = app.pre.querySelector('.code-view-gutter');
        const style = app.window.getComputedStyle(gutter);
        assert.equal(style.position, 'sticky');
        assert.equal(style.left, '0px');
        assert.equal(style.userSelect, 'none');
        assert.equal(style.pointerEvents, 'none');
        assert.equal(app.window.getComputedStyle(app.pre).maxHeight, '65vh');
        assert.match(css, /content:\s*attr\(data-lines\)/);
    });

    test('repeated rendering reuses elements, updates numbering and can enable highlighting later', t => {
        const app = harness(t, false);
        const text = '{"value":42}\n';
        const first = app.render(text, 'json');
        const gutter = app.pre.querySelector('.code-view-gutter');
        assert.equal(first.querySelector('.token'), null);
        prism(app.window);
        assert.equal(app.render(text, 'json'), first);
        assert.ok(first.querySelector('.token'));
        const token = first.querySelector('.token');
        app.render(text, 'json');
        assert.equal(first.querySelector('.token'), token, 'unchanged output is not highlighted again');
        app.render('<value/>', 'xml');
        assert.equal(app.pre.querySelector('code'), first);
        assert.equal(app.pre.querySelector('.code-view-gutter'), gutter);
        assert.equal(first.className, 'language-markup');
        assert.equal(app.pre.childElementCount, 2);
        assert.equal(app.pre.dataset.lineCount, '1');
    });

    test('large sources keep complete text and virtualize only the decorative number list', t => {
        const app = harness(t);
        const text = 'value\r\n'.repeat(50_000);
        app.window.Prism.tokenize = () => { throw new Error('large source must skip tokenization'); };
        Object.defineProperty(app.pre, 'clientHeight', {value: 300});
        const code = app.render(text, 'json');
        const gutter = app.pre.querySelector('.code-view-gutter');
        assert.equal(code.textContent, text);
        assert.equal(code.querySelector('.token'), null);
        assert.equal(app.pre.dataset.lineCount, '50001');
        assert.ok(gutter.dataset.lines.split('\n').length <= 100, 'number DOM is bounded to the visible range');
        assert.equal(app.pre.childElementCount, 2);
        app.pre.scrollTop = 84_000;
        app.pre.dispatchEvent(new app.window.Event('scroll'));
        assert.ok(Number(gutter.dataset.lines.split('\n')[0]) > 4_000);
        assert.ok(parseFloat(gutter.style.getPropertyValue('--code-view-number-offset')) > 80_000);
        assert.equal(code.textContent, text, 'scrolling numbers never changes the source');
    });

    test('a missing or failing highlighter falls back to numbered, readable exact text', t => {
        const app = harness(t);
        app.window.Prism.tokenize = () => { throw new Error('tokenizer unavailable'); };
        const text = '{"value":"<unsafe>"}\r\n';
        const code = app.render(text, 'json');
        assert.equal(code.textContent, text);
        assert.equal(code.querySelector('.token'), null);
        assert.equal(app.pre.dataset.lineCount, '2');
        app.window.Prism = null;
        assert.equal(app.render(text, 'not a language').className, 'language-none');
        assert.equal(code.textContent, text);
    });

    test('the shared highlighter reports success while preserving Unicode and exact editable text', t => {
        const app = harness(t);
        const code = app.window.document.createElement('code');
        const text = '{"value":"\u00a0München\u00a0"}\r\n';
        assert.equal(app.window.CodeView.highlight(code, text, 'json'), true);
        assert.equal(code.textContent, text);
        assert.ok(code.querySelector('.token'));
        app.window.Prism = null;
        assert.equal(app.window.CodeView.highlight(code, text, 'json'), false);
        assert.equal(code.textContent, text);
    });

    test('views rendered before insertion recalculate actual typography after being appended', t => {
        const app = harness(t);
        app.pre.remove();
        const frames = [];
        app.window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
        const code = app.render('line\n'.repeat(6_000));
        const detachedHeight = code.style.minHeight;
        app.window.document.body.append(app.pre);
        code.style.fontSize = '20px';
        code.style.lineHeight = '2';
        code.style.paddingTop = '12px';
        code.style.paddingBottom = '12px';
        assert.equal(frames.length, 1);
        frames[0]();
        assert.notEqual(code.style.minHeight, detachedHeight);
        assert.equal(code.style.minHeight, (6_001 * 40 + 24) + 'px');
        assert.equal(code.textContent, 'line\n'.repeat(6_000));
    });
}
