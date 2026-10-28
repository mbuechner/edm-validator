// Optional DOM tests: npm install --no-save --prefix target/ui-check jsdom@26.1.0
// Run: node --test src/test/js/pages.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
let JSDOM;
try {
    ({ JSDOM } = require(path.join(root, 'target/ui-check/node_modules/jsdom')));
} catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    test('Page navigation and editor appearance', {
        skip: 'Install optional test tools: npm install --no-save --prefix target/ui-check jsdom@26.1.0'
    }, () => {});
}

if (JSDOM) {
    const read = file => fs.readFileSync(path.join(root, 'src/main/resources/static', file), 'utf8');
    const pages = { validation: read('index.html'), converter: read('converter.html') };
    const navigation = read('navigation.js');
    const messages = read('messages.js');
    const bundlePath = path.join(root, 'target/bootstrap.bundle.min.js');
    const bootstrapCssPath = path.join(root, 'target/bootstrap.min.css');
    const bootstrapCss = fs.existsSync(bootstrapCssPath) ? fs.readFileSync(bootstrapCssPath, 'utf8') :
        ':root{--bs-body-color:#212529;--bs-body-bg:#fff;--bs-font-monospace:monospace}' +
        '.container-fluid,.w-100{width:100%}.mw-100{max-width:100%}.mx-0{margin-left:0!important;margin-right:0!important}';
    const handoffKey = 'ddb-edm-converter-handoff-v1';
    const xml = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
        '<rdf:Description rdf:about="https://example.org/organisation"/></rdf:RDF>';

    function page(t, name, base = '/app/edm-validator/') {
        const dom = new JSDOM(pages[name], {
            url: 'https://validator.example' + base + (name === 'converter' ? 'converter.html' : ''),
            runScripts: 'outside-only'
        });
        t.after(() => dom.window.close());
        return dom.window;
    }

    function addStyles(window, text) {
        const style = window.document.createElement('style');
        style.textContent = text;
        window.document.head.append(style);
        return style;
    }

    function navigationPage(t, { empty = false, storageError = false } = {}) {
        const window = page(t, 'validation', '/custom/nested/tools/');
        const documentIri = 'https://api.example/items/123/source.rdf';
        window.document.getElementById('xmlCode').textContent = empty ? '' : xml;
        if (storageError) {
            Object.defineProperty(window.Storage.prototype, 'setItem', {
                value() { throw new Error('Storage unavailable'); }
            });
        }
        window.eval('let lastValidationData = ' + JSON.stringify({ apiUrl: documentIri }) + ';\n' + navigation);
        const link = window.document.getElementById('convertDisplayedXml');
        let navigationPrevented;
        link.addEventListener('click', event => {
            navigationPrevented = event.defaultPrevented;
            // Preserve and inspect the production handler's native-navigation decision.
            event.preventDefault();
        });
        link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
        return { window, link, documentIri, navigationPrevented };
    }

    function styledConverter(t) {
        const window = page(t, 'converter');
        addStyles(window, bootstrapCss);
        addStyles(window, '.form-control:focus {color:#fff;background-color:#fff;-webkit-text-fill-color:#fff;}');
        // jsdom leaves CSS custom properties unresolved. Resolve the test stylesheet
        // against Bootstrap's actual light-theme tokens, retaining production selectors.
        const tokens = window.getComputedStyle(window.document.documentElement);
        const localCss = read('converter.css').replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
            (_match, name, fallback) => tokens.getPropertyValue(name).trim() || fallback || '');
        const local = addStyles(window, localCss);
        // jsdom does not evaluate the OS forced-colors media feature.
        const normalColors = [...local.sheet.cssRules].find(rule => rule.media && rule.conditionText === '(forced-colors: none)');
        assert.ok(normalColors);
        addStyles(window, [...normalColors.cssRules].map(rule => rule.cssText).join('\n'));
        return window;
    }

    function sharedSourceStyles(window, converter = false) {
        addStyles(window, bootstrapCss);
        addStyles(window, 'pre[class*="language-"],code[class*="language-"]{font-family:Consolas,monospace;font-size:1em;line-height:1.5;}' +
            '.line-numbers-rows{font-family:inherit;font-size:1em;line-height:inherit;}');
        const tokens = window.getComputedStyle(window.document.documentElement);
        const resolve = css => css.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
            (_match, name, fallback) => tokens.getPropertyValue(name).trim() || fallback || '');
        if (converter) addStyles(window, resolve(read('converter.css')));
        addStyles(window, resolve(read('source.css')));
    }

    function contrast(foreground, background) {
        const luminance = color => {
            const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(component => {
                const value = component / 255;
                return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return (values[0] + 0.05) / (values[1] + 0.05);
    }

    test('separate pages expose accessible Bootstrap navbars with base-path-safe active links', t => {
        for (const base of ['/app/edm-validator/', '/custom/nested/tools/']) {
            for (const name of ['validation', 'converter']) {
                const document = page(t, name, base).document;
                assert.equal(!!document.getElementById('validationForm'), name === 'validation');
                assert.equal(!!document.getElementById('converterForm'), name === 'converter');
                const navbar = document.querySelector('nav.navbar.navbar-expand-lg[aria-label="Werkzeuge"]');
                assert.ok(navbar, 'Bootstrap navbar on ' + name);
                const brand = navbar.querySelector('a.navbar-brand');
                assert.ok(brand);
                assert.equal(brand.href, 'https://validator.example' + base);
                const toggle = navbar.querySelector('button.navbar-toggler');
                assert.ok(toggle);
                assert.equal(toggle.type, 'button');
                assert.equal(toggle.getAttribute('data-bs-toggle'), 'collapse');
                assert.equal(toggle.getAttribute('aria-expanded'), 'false');
                assert.ok(toggle.getAttribute('aria-label'));
                assert.ok(toggle.querySelector('.navbar-toggler-icon'));
                const target = document.querySelector(toggle.getAttribute('data-bs-target'));
                assert.ok(target.classList.contains('collapse'));
                assert.ok(target.classList.contains('navbar-collapse'));
                assert.equal(toggle.getAttribute('aria-controls'), target.id);
                assert.ok(target.querySelector('.navbar-nav'));
                assert.equal(document.getElementById('showValidator').href, 'https://validator.example' + base);
                assert.equal(document.getElementById('showConverter').href, 'https://validator.example' + base + 'converter.html');
                assert.ok(document.getElementById('showValidator').closest('.nav-item'));
                assert.ok(document.getElementById('showConverter').closest('.nav-item'));
                const active = navbar.querySelectorAll('[aria-current="page"]');
                assert.equal(active.length, 1);
                assert.equal(active[0].id, name === 'converter' ? 'showConverter' : 'showValidator');
                assert.equal(document.querySelector('link[href="./app.css"]'), null);
                const css = document.querySelector('link[href*="bootstrap@5.3.3/dist/css/bootstrap.min.css"]');
                const bundle = document.querySelector('script[src*="bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"]');
                assert.ok(css);
                assert.ok(bundle);
                assert.ok(css.getAttribute('integrity'));
                assert.ok(bundle.getAttribute('integrity'));
                assert.equal(bundle.getAttribute('crossorigin'), 'anonymous');
            }
        }
    });

    test('the actual Bootstrap bundle opens and closes each responsive navbar', {
        skip: !fs.existsSync(bundlePath) && 'Download the configured Bootstrap bundle to target/bootstrap.bundle.min.js to exercise its real Collapse plugin.'
    }, async t => {
        const bytes = fs.readFileSync(bundlePath);
        const sri = 'sha384-' + crypto.createHash('sha384').update(bytes).digest('base64');
        for (const name of ['validation', 'converter']) {
            const window = page(t, name);
            addStyles(window, bootstrapCss);
            const bundle = window.document.querySelector('script[src*="/bootstrap.bundle.min.js"]');
            assert.equal(bundle.getAttribute('integrity'), sri);
            window.eval(bytes.toString('utf8'));
            const toggle = window.document.querySelector('.navbar-toggler');
            const collapse = window.document.querySelector(toggle.getAttribute('data-bs-target'));
            assert.equal(collapse.classList.contains('show'), false);
            const nextEvent = name => new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Missing Bootstrap event ' + name)), 1500);
                collapse.addEventListener(name, () => { clearTimeout(timeout); resolve(); }, {once: true});
            });
            const opened = nextEvent('shown.bs.collapse');
            toggle.click();
            await opened;
            assert.equal(collapse.classList.contains('show'), true);
            assert.equal(toggle.getAttribute('aria-expanded'), 'true');
            const closed = nextEvent('hidden.bs.collapse');
            toggle.click();
            await closed;
            assert.equal(collapse.classList.contains('show'), false);
            assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        }
    });

    test('converter presentation reuses Bootstrap grid, cards and radio buttons', t => {
        const document = page(t, 'converter').document;
        assert.ok(document.querySelector('main.container-fluid'));
        for (const id of ['converterForm', 'converterOutputPanel']) {
            const panel = document.getElementById(id);
            assert.ok(panel.closest('.card'), id + ' uses a card');
            const column = panel.closest('.col-xl-6');
            assert.ok(column, id + ' uses a responsive half-width column');
            assert.ok(column.closest('.row'));
        }
        for (const id of ['converterRdfXml', 'converterJsonLd']) {
            assert.ok(document.getElementById(id).classList.contains('btn-check'));
            assert.ok(document.querySelector('label.btn[for="' + id + '"]'));
        }
        assert.equal(document.querySelector('.converter-layout,.converter-panel,.converter-format-choice'), null);
    });

    test('global messages occupy one shared Bootstrap alert area above each page heading', t => {
        for (const name of ['validation', 'converter']) {
            const document = page(t, name).document;
            const area = document.getElementById('pageMessages');
            assert.ok(area, name + ' has a central message area');
            assert.ok(area.classList.contains('sticky-top'));
            assert.ok(area.closest('main'));
            assert.equal(area.closest('form'), null);
            assert.ok(area.compareDocumentPosition(document.querySelector('h1')) & 4, 'messages precede the heading');
            for (const id of name === 'validation' ? ['result'] : ['converterStatus', 'converterErrors']) {
                const element = document.getElementById(id);
                assert.ok(element);
                assert.equal(element.closest('#pageMessages'), area);
                assert.equal(document.querySelectorAll('#' + id).length, 1);
                assert.equal(element.closest('form'), null);
            }
            const scripts = [...document.scripts];
            const helper = scripts.findIndex(script => script.getAttribute('src') === './messages.js');
            const bundle = scripts.findIndex(script => script.src.includes('/bootstrap.bundle.min.js'));
            const application = scripts.findIndex(script => name === 'converter' ?
                script.getAttribute('src') === './converter.js' : script.textContent.includes('function setResult'));
            assert.ok(helper > bundle && bundle >= 0, 'message helper follows Bootstrap');
            assert.ok(application > helper, 'application scripts can use the shared helper');
        }
    });

    test('Bootstrap alert dismissal keeps central targets reusable and messages remain safe text', {
        skip: !fs.existsSync(bundlePath) && 'Download the configured Bootstrap bundle to target/bootstrap.bundle.min.js to exercise real Alert dismissal.'
    }, async t => {
        const bundle = fs.readFileSync(bundlePath, 'utf8');
        const unsafe = 'Fehler: <img src=x onerror=alert(1)> & "Details"';
        for (const name of ['validation', 'converter']) {
            const window = page(t, name);
            window.eval(bundle);
            window.eval(messages);
            const id = name === 'validation' ? 'result' : 'converterStatus';
            const element = window.document.getElementById(id);
            window.AppMessages.show(element, 'danger', unsafe);
            const alert = element.querySelector('.alert');
            assert.ok(alert.classList.contains('alert-danger'));
            assert.ok(alert.classList.contains('alert-dismissible'));
            assert.equal(element.classList.contains('d-none'), false);
            assert.equal(alert.getAttribute('role'), 'alert');
            assert.equal(alert.getAttribute('aria-live'), 'assertive');
            assert.ok(element.textContent.includes(unsafe));
            assert.equal(element.querySelector('img'), null);
            const close = element.querySelector('button.btn-close[data-bs-dismiss="alert"]');
            assert.ok(close);
            assert.ok(close.getAttribute('aria-label'));
            const afterClose = target => new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Bootstrap did not finish dismissing the alert')), 1500);
                target.addEventListener('closed.bs.alert', () => { clearTimeout(timeout); resolve(); }, {once: true});
            });
            const dismissed = afterClose(alert);
            close.click();
            await dismissed;
            assert.equal(window.document.getElementById(id), element, 'dismissal retains the application target');
            assert.ok(element.hidden || element.classList.contains('d-none'), 'dismissed alert is hidden');
            window.AppMessages.show(element, 'success', 'Erfolgreich konvertiert.');
            assert.equal(window.document.getElementById(id), element);
            assert.equal(element.classList.contains('d-none'), false);
            assert.equal(element.hidden, false);
            const success = element.querySelector('.alert');
            assert.ok(success.classList.contains('alert-success'));
            assert.equal(success.classList.contains('alert-danger'), false);
            assert.equal(success.getAttribute('role'), 'status');
            assert.equal(success.getAttribute('aria-live'), 'polite');
            assert.ok(element.textContent.includes('Erfolgreich konvertiert.'));
            assert.equal(element.querySelectorAll('button.btn-close').length, 1);
            const oldClose = afterClose(success);
            success.querySelector('.btn-close').click();
            window.AppMessages.show(element, 'info', 'Eine neuere Meldung bleibt sichtbar.');
            await oldClose;
            assert.equal(element.classList.contains('d-none'), false, 'an old fade-out does not hide a newer message');
            assert.ok(element.querySelector('.alert-info'));
            assert.ok(element.textContent.includes('Eine neuere Meldung bleibt sichtbar.'));
        }
    });

    test('multiline diagnostics remain safe text with readable context lines and reusable alerts', t => {
        const lines = [
            'Originalfehler: <invalid> & "Details"',
            'Prädikat: https://example.org/vocabulary/property',
            'Präfix: ex = https://example.org/vocabulary/',
            'Subjekt: <img src=x onerror=alert(1)>'
        ];
        for (const name of ['validation', 'converter']) {
            const window = page(t, name);
            window.eval(messages);
            const host = window.document.getElementById(name === 'validation' ? 'result' : 'converterStatus');
            for (const newline of ['\n', '\r\n', '\r']) {
                window.AppMessages.show(host, 'danger', lines.join(newline));
                const alert = host.querySelector('.alert-danger');
                const content = alert.querySelector(':scope > div');
                assert.ok(content.classList.contains('d-grid'));
                assert.ok(content.classList.contains('gap-1'));
                const paragraphs = [...content.querySelectorAll('p')];
                assert.deepEqual(paragraphs.map(paragraph => paragraph.textContent), lines);
                assert.ok(paragraphs[0].classList.contains('fw-semibold'));
                assert.ok(paragraphs.every(paragraph => paragraph.classList.contains('mb-0') &&
                    paragraph.classList.contains('text-break')));
                assert.equal(host.querySelector('img'), null, 'diagnostic contents never become HTML');
                assert.equal(alert.getAttribute('role'), 'alert');
                assert.equal(alert.getAttribute('aria-live'), 'assertive');
            }
            host.querySelector('.btn-close').click();
            assert.equal(host.children.length, 0, 'dismissal works without the optional Bootstrap script');
            assert.ok(host.classList.contains('d-none'));
            const single = 'Erneut konvertiert: <rdf:RDF> & "Details"';
            window.AppMessages.show(host, 'success', single);
            assert.equal(host.querySelector('.alert > span').textContent, single,
                'single-line messages retain their existing text rendering');
            assert.equal(host.classList.contains('d-none'), false);
        }
    });

    test('the converter is immediately visible and loads no validation, jQuery or graph code', t => {
        const document = page(t, 'converter').document;
        assert.equal(document.getElementById('converterWorkspace').classList.contains('d-none'), false);
        assert.equal(document.getElementById('validatorWorkspace'), null);
        assert.ok(document.querySelector('script[src="./converter.js"]'));
        assert.equal([...document.scripts].some(script => /jquery|navigation\.js|3d-force-graph/.test(script.src) ||
            /function renderGraph|api\/validate/.test(script.textContent)), false);
        const validation = page(t, 'validation').document;
        assert.equal(validation.querySelector('script[src="./converter.js"]'), null);
        assert.ok(validation.querySelector('script[src="./navigation.js"]'));
    });

    test('document handoff stores source XML and its known IRI once without putting data in the URL', t => {
        const app = navigationPage(t);
        assert.equal(app.navigationPrevented, false);
        assert.equal(app.link.href, 'https://validator.example/custom/nested/tools/converter.html');
        assert.deepEqual(JSON.parse(app.window.sessionStorage.getItem(handoffKey)), {rdfXml: xml, documentIri: app.documentIri});
        assert.equal(app.link.search, '');
        assert.equal(app.link.hash, '');
        assert.equal(app.window.localStorage.length, 0);
    });

    test('empty sources and unavailable session storage prevent a broken document handoff', t => {
        const empty = navigationPage(t, {empty: true});
        assert.equal(empty.navigationPrevented, true);
        assert.equal(empty.window.sessionStorage.getItem(handoffKey), null);
        const blocked = navigationPage(t, {storageError: true});
        assert.equal(blocked.navigationPrevented, true);
        assert.equal(blocked.window.sessionStorage.getItem(handoffKey), null);
        const error = blocked.window.document.getElementById('converterNavigationError');
        assert.ok(error);
        assert.equal(error.getAttribute('role'), 'alert');
        assert.match(error.textContent, /nicht.*übergeben/);
    });

    test('Bootstrap fluid containers and width utilities retain full-width pages without pixel caps', t => {
        for (const name of ['validation', 'converter']) {
            const window = page(t, name);
            addStyles(window, bootstrapCss);
            if (name === 'converter') addStyles(window, read('converter.css'));
            const main = window.document.querySelector('main.container-fluid');
            const workspace = window.document.getElementById(name === 'converter' ? 'converterWorkspace' : 'validatorWorkspace');
            assert.ok(main);
            for (const element of [main, workspace]) {
                const computed = window.getComputedStyle(element);
                assert.equal(computed.width, '100%');
                assert.ok(['', 'none', '100%'].includes(computed.maxWidth), 'no fixed width cap');
            }
            if (name === 'validation') {
                const graph = window.document.getElementById('graphPanel');
                assert.ok(graph.classList.contains('w-100'));
                assert.ok(graph.classList.contains('mw-100'));
                assert.equal(window.getComputedStyle(graph).width, '100%');
            }
        }
    });

    test('XML and JSON editors stay readable on focus with or without the optional Prism mirror', t => {
        const window = styledConverter(t);
        for (const id of ['converterInput', 'converterContext', 'converterFrame']) {
            const textarea = window.document.getElementById(id);
            for (const enhanced of [false, true]) {
                textarea.parentElement.classList.toggle('converter-editor-highlighted', enhanced);
                textarea.focus();
                assert.equal(window.document.activeElement, textarea);
                assert.equal(textarea.parentElement.matches(':focus-within'), true);
                const computed = window.getComputedStyle(textarea);
                assert.equal(computed.color, 'rgb(33, 37, 41)', id);
                assert.equal(computed.getPropertyValue('-webkit-text-fill-color'), 'rgb(33, 37, 41)', id);
                assert.equal(computed.backgroundColor, 'rgb(255, 255, 255)', id);
                assert.ok(contrast(computed.color, computed.backgroundColor) >= 7, id + ' high-contrast editing');
                assert.equal(window.getComputedStyle(textarea.parentElement.querySelector('pre')).display, 'none');
                textarea.blur();
            }
        }
    });

    test('without highlighting JavaScript the XML input is dark, readable and editable immediately', t => {
        const window = styledConverter(t);
        const textarea = window.document.getElementById('converterInput');
        assert.equal(textarea.parentElement.classList.contains('converter-editor-highlighted'), false);
        textarea.value = xml;
        const computed = window.getComputedStyle(textarea);
        assert.equal(computed.color, 'rgb(33, 37, 41)');
        assert.equal(computed.getPropertyValue('-webkit-text-fill-color'), 'rgb(33, 37, 41)');
        assert.equal(textarea.value, xml);
        assert.equal(window.getComputedStyle(textarea.parentElement.querySelector('pre')).display, 'none');
    });

    test('XML and JSON sources share one compact monospace font across editors, previews, results and line numbers', async t => {
        const windows = ['validation', 'converter'].map(name => {
            const window = page(t, name);
            const links = [...window.document.querySelectorAll('link[rel="stylesheet"]')];
            const shared = links.findIndex(link => link.getAttribute('href') === './source.css');
            const prism = links.map((link, index) => link.href.includes('prismjs') ? index : -1).filter(index => index >= 0);
            assert.ok(shared > Math.max(...prism), 'the shared source font follows Prism styles');
            sharedSourceStyles(window, name === 'converter');
            return window;
        });
        const [validation, converter] = windows;
        const xmlPre = validation.document.getElementById('xmlCode').closest('pre');
        const gutter = validation.document.createElement('span');
        gutter.className = 'line-numbers-rows';
        xmlPre.append(gutter);
        converter.requestAnimationFrame = callback => converter.setTimeout(callback, 0);
        converter.TextEncoder = TextEncoder;
        converter.TextDecoder = TextDecoder;
        converter.Blob = Blob;
        converter.Prism = {highlightElement() {}};
        const resultContent = '{"@id":"https://example.org/resource"}';
        converter.fetch = async () => ({ok: true, status: 200, json: async () => ({
            results: [{id: 'compacted', fileName: 'compacted.jsonld', mediaType: 'application/ld+json',
                content: resultContent, sizeBytes: Buffer.byteLength(resultContent, 'utf8'), error: null, empty: false}],
            errors: [], autoContext: '{"@context":{}}', resources: [], effectiveFrame: null
        })});
        converter.eval(messages);
        converter.eval(read('converter.js'));
        converter.document.getElementById('converterInput').value = xml;
        converter.document.getElementById('converterForm').dispatchEvent(new converter.Event('submit', {bubbles: true, cancelable: true}));
        await new Promise(resolve => setImmediate(resolve));
        const output = converter.document.querySelector('#converterResults pre');
        assert.ok(output.classList.contains('source-code'), 'generated result uses the shared source style');
        let family;
        function check(window, element) {
            const style = window.getComputedStyle(element);
            const size = style.fontSize.endsWith('rem') ? parseFloat(style.fontSize) * 16 : parseFloat(style.fontSize);
            assert.equal(size, 12, element.id || element.tagName);
            const lineHeight = style.lineHeight.endsWith('px') ? parseFloat(style.lineHeight) / size : parseFloat(style.lineHeight);
            assert.ok(Math.abs(lineHeight - 1.4) < 0.001, 'compact, identical source line height');
            family ||= style.fontFamily;
            assert.equal(style.fontFamily, family, 'all sources use the same monospace stack');
            assert.match(style.fontFamily, /monospace/);
        }
        for (const element of [validation.document.getElementById('rdfXmlInput'), xmlPre,
            validation.document.getElementById('xmlCode'), gutter]) check(validation, element);
        for (const id of ['converterInput', 'converterContext', 'converterFrame']) {
            const textarea = converter.document.getElementById(id);
            for (const focused of [true, false]) {
                if (focused) textarea.focus(); else textarea.blur();
                check(converter, textarea);
                check(converter, textarea.parentElement.querySelector('pre'));
                check(converter, textarea.parentElement.querySelector('code'));
            }
        }
        for (const element of [converter.document.getElementById('converterAutoContext'),
            converter.document.getElementById('converterFramePreview'), output, output.querySelector('code')]) check(converter, element);
    });
}
