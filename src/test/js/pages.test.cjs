// npm install --no-save --prefix target/ui-check jsdom@26.1.0
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
let JSDOM;
try { ({ JSDOM } = require(path.join(root, 'target/ui-check/node_modules/jsdom'))); }
catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    test('Shared tool pages', {skip: 'Install optional jsdom test tools.'}, () => {});
}

if (JSDOM) {
    const read = name => fs.readFileSync(path.join(root, 'src/main/resources/static', name), 'utf8');
    const pages = {validation: 'validation.html', explorer: 'index.html', query: 'query.html', converter: 'converter.html'};
    const bundles = path.join(root, 'target/bootstrap.bundle.min.js');
    const bootstrapCssPath = path.join(root, 'target/bootstrap.min.css');
    const bootstrapCss = fs.existsSync(bootstrapCssPath) ? fs.readFileSync(bootstrapCssPath, 'utf8') :
        ':root{--bs-body-color:#212529;--bs-body-bg:#fff;--bs-font-monospace:monospace}.container-fluid,.w-100{width:100%}';
    const xml = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="https://example.org/a"/></rdf:RDF>';

    function page(t, name, base = '/app/edm-validator/') {
        const dom = new JSDOM(read(pages[name]), {url: 'https://validator.example' + base + (name === 'explorer' ? '' : pages[name]), runScripts: 'outside-only'});
        t.after(() => dom.window.close());
        return dom.window;
    }
    function styles(window, css) {
        const element = window.document.createElement('style');
        element.textContent = css;
        window.document.head.append(element);
    }
    function mount(window) { window.eval(read('messages.js')); window.eval(read('rdf-source.js')); }

    test('four separate tools use base-path-safe Bootstrap navigation and only one active page', t => {
        for (const base of ['/app/edm-validator/', '/custom/nested/tools/']) {
            for (const [name, file] of Object.entries(pages)) {
                const {document} = page(t, name, base);
                const navbar = document.querySelector('nav.navbar.navbar-expand-lg[aria-label="Werkzeuge"]');
                assert.ok(navbar);
                const links = [...navbar.querySelectorAll('.navbar-nav a')];
                assert.deepEqual(links.map(link => link.textContent), ['Explorer', 'Validierung', 'Query', 'Konverter']);
                assert.deepEqual(links.map(link => link.href), ['', 'validation.html', 'query.html', 'converter.html'].map(target => 'https://validator.example' + base + target));
                const active = links.filter(link => link.getAttribute('aria-current') === 'page');
                assert.equal(active.length, 1);
                assert.equal(active[0].getAttribute('href'), name === 'explorer' ? './' : './' + file);
                assert.equal(document.querySelector('h1').textContent, active[0].textContent);
                assert.ok(document.title.startsWith(active[0].textContent + ' ·'));
                assert.ok(document.title.endsWith(' · EDM-Werkzeuge · DDBpro'));
                const brand = navbar.querySelector('.navbar-brand');
                assert.equal(brand.querySelector('img').getAttribute('src'), './images/ddbpro.svg');
                assert.equal(brand.querySelector('img').getAttribute('alt'), 'DDBpro');
                assert.equal(brand.querySelector('span').textContent, 'EDM-Werkzeuge');
                assert.ok(brand.querySelector('img[src="./images/ddb-signet.svg"]'));
                const toggle = navbar.querySelector('.navbar-toggler');
                assert.equal(toggle.type, 'button');
                assert.ok(document.querySelector(toggle.getAttribute('data-bs-target')).classList.contains('navbar-collapse'));
                assert.ok(document.querySelector('link[href*="bootstrap@5.3.3"]').getAttribute('integrity'));
                assert.equal(!!document.getElementById('validationForm'), name === 'validation');
                assert.equal(!!document.getElementById('graphPanel'), name === 'explorer');
                assert.equal(!!document.getElementById('queryWorkspace'), name === 'query');
                assert.equal(!!document.getElementById('converterForm'), name === 'converter');
            }
        }
    });

    test('every tool shows its heading and description above the identical persisted source', t => {
        let markup;
        let saved;
        for (const name of Object.keys(pages)) {
            const window = page(t, name);
            if (saved) window.localStorage.setItem('ddb-rdf-source-v1', saved);
            mount(window);
            const source = window.document.getElementById('rdfSource');
            const header = window.document.querySelector('main').firstElementChild;
            assert.equal(header.tagName, 'HEADER');
            assert.ok(header.querySelector('h1'));
            assert.ok(header.querySelector('p').textContent.trim());
            assert.equal(header.nextElementSibling, source);
            const input = window.document.getElementById('rdfXmlInput');
            assert.equal(input.closest('#rdfSource'), source);
            assert.equal(input.className, markup || input.className);
            markup ||= input.className;
            assert.equal(input.disabled, false);
            assert.equal(window.document.querySelectorAll('#rdfXmlInput').length, 1);
            if (name === 'validation') {
                input.value = xml;
                input.dispatchEvent(new window.Event('input', {bubbles: true}));
                // Navigation/pagehide must flush an edit before loading the next page.
                window.dispatchEvent(new window.Event('pagehide'));
                saved = window.localStorage.getItem('ddb-rdf-source-v1');
                assert.ok(saved);
            } else assert.equal(input.value, xml, name + ' reads the same source without a handoff');
            assert.equal(window.RdfSource.get().rdfXml, xml);
        }
    });

    test('only the explorer loads graph helpers and only the converter loads conversion controls', t => {
        for (const name of Object.keys(pages)) {
            const {document} = page(t, name);
            assert.equal(!!document.querySelector('script[src="./graph.js"]'), name === 'explorer');
            assert.equal(!!document.querySelector('script[src="./converter.js"]'), name === 'converter');
            const scripts = [...document.scripts].map(script => script.getAttribute('src'));
            assert.ok(scripts.indexOf('./rdf-source.js') > scripts.indexOf('./messages.js'));
            assert.ok(scripts.indexOf('./rdf-source.js') < scripts.indexOf('./' + ({validation: 'validation', explorer: 'explorer', query: 'query', converter: 'converter'}[name]) + '.js'));
            assert.equal(scripts.some(src => /jquery|navigation\.js/.test(src)), false);
        }
    });

    test('source typography and readable focus colors are identical on all pages', t => {
        let metrics;
        for (const name of Object.keys(pages)) {
            const window = page(t, name);
            mount(window);
            styles(window, bootstrapCss);
            if (name === 'converter') styles(window, read('converter.css'));
            styles(window, read('source.css').replace(/var\(--bs-font-monospace, monospace\)/g, 'monospace'));
            const input = window.document.getElementById('rdfXmlInput');
            for (const focus of [true, false]) {
                if (focus) input.focus(); else input.blur();
                const computed = window.getComputedStyle(input);
                const value = [computed.fontFamily, computed.fontSize, computed.lineHeight, computed.color, computed.backgroundColor];
                metrics ||= value;
                assert.deepEqual(value, metrics, name);
                assert.equal(computed.fontSize, '0.75rem');
                assert.notEqual(computed.color, 'rgba(0, 0, 0, 0)');
            }
        }
    });

    test('the actual Bootstrap bundle opens and closes all four responsive navbars', {
        skip: !fs.existsSync(bundles) && 'Bootstrap bundle unavailable locally.'
    }, async t => {
        const bytes = fs.readFileSync(bundles);
        for (const name of Object.keys(pages)) {
            const window = page(t, name);
            assert.equal(window.document.querySelector('script[src*="/bootstrap.bundle.min.js"]').getAttribute('integrity'),
                'sha384-' + crypto.createHash('sha384').update(bytes).digest('base64'));
            window.eval(bytes.toString('utf8'));
            const toggle = window.document.querySelector('.navbar-toggler');
            const collapse = window.document.querySelector(toggle.getAttribute('data-bs-target'));
            for (const state of [true, false]) {
                const completed = new Promise(resolve => collapse.addEventListener(state ? 'shown.bs.collapse' : 'hidden.bs.collapse', resolve, {once: true}));
                toggle.click();
                await completed;
                assert.equal(collapse.classList.contains('show'), state);
                assert.equal(toggle.getAttribute('aria-expanded'), String(state));
            }
        }
    });

    test('dismissible alerts remain reusable and render document-derived messages as safe text', t => {
        for (const name of Object.keys(pages)) {
            const window = page(t, name);
            window.eval(read('messages.js'));
            const host = window.document.getElementById(name === 'converter' ? 'converterStatus' : 'result');
            window.AppMessages.show(host, 'danger', '<img src=x onerror=alert(1)>');
            assert.equal(host.querySelector('img'), null);
            host.querySelector('.btn-close').click();
            assert.equal(host.children.length, 0);
            window.AppMessages.show(host, 'success', 'Erneute Meldung');
            assert.match(host.textContent, /Erneute Meldung/);
        }
    });
}
