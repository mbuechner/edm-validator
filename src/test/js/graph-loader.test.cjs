// Optional DOM tests: npm install --no-save --prefix target/ui-check jsdom@26.1.0
// Run: node --test src/test/js/graph-loader.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
let JSDOM;
try {
    ({ JSDOM } = require(path.join(root, 'target/ui-check/node_modules/jsdom')));
} catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    test('Graph loader DOM tests', {
        skip: 'Install optional test tools: npm install --no-save --prefix target/ui-check jsdom@26.1.0'
    }, () => {});
}

if (JSDOM) {
    const html = fs.readFileSync(path.join(root, 'src/main/resources/static/index.html'), 'utf8');
    const libraryUrl = 'https://unpkg.com/3d-force-graph';
    function graphData(prefix) {
        return {
            graphNodes: [prefix + '/subject', prefix + '/object'].map(id => ({ id, nodeType: 'IRI' })),
            graphLinks: [{ source: prefix + '/subject', target: prefix + '/object', predicate: 'related' }]
        };
    }

    function harness(t) {
        const dom = new JSDOM(html, { url: 'https://validator.example/', runScripts: 'outside-only' });
        const { window } = dom;
        const frames = [];
        const rendered = [];
        // Keep ready handlers idle; this test exercises the existing graph functions only.
        window.$ = selector => {
            if (typeof selector === 'function') return;
            const elements = [...window.document.querySelectorAll(selector)];
            const wrapper = {
                addClass(name) { elements.forEach(el => el.classList.add(name)); return wrapper; },
                removeClass(name) { elements.forEach(el => el.classList.remove(name)); return wrapper; },
                text(value) { elements.forEach(el => { el.textContent = value; }); return wrapper; },
                val(value) {
                    if (value === undefined) return elements[0]?.value;
                    elements.forEach(el => { el.value = value; }); return wrapper;
                },
                prop(name, value) { elements.forEach(el => { el[name] = value; }); return wrapper; },
                is() { return !!elements[0]?.checked; },
                empty() { elements.forEach(el => el.replaceChildren()); return wrapper; },
                append(value) { elements.forEach(el => el.insertAdjacentHTML('beforeend', value)); return wrapper; }
            };
            return wrapper;
        };
        window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
        const inlineScript = [...window.document.scripts].find(script => script.textContent.includes('function renderGraph'));
        window.eval(inlineScript.textContent);
        const graph = new Proxy({}, { get(_target, property) {
            return value => {
                if (property === 'graphData') rendered.push(value);
                return graph;
            };
        } });
        const provideLibrary = () => {
            window.ForceGraph3D = () => () => graph;
            window.document.querySelector(`script[src="${libraryUrl}"]`).dispatchEvent(new window.Event('load'));
        };
        const flushFrames = () => { while (frames.length) frames.shift()(); };
        const scripts = () => [...window.document.querySelectorAll(`script[src="${libraryUrl}"]`)];
        t.after(() => window.close());
        return { window, provideLibrary, flushFrames, scripts, rendered };
    }

    test('the validation page loads the graph library only on demand and shares one load', async t => {
        const app = harness(t);
        assert.equal(app.scripts().length, 0);
        await app.window.renderGraph({ graphNodes: [], graphLinks: [] });
        assert.equal(app.scripts().length, 0);
        const older = app.window.renderGraph(graphData('https://old.example'));
        const newer = app.window.renderGraph(graphData('https://new.example'));
        assert.equal(app.scripts().length, 1);
        assert.equal(app.scripts()[0].async, true);
        app.provideLibrary();
        await Promise.all([older, newer]);
        app.flushFrames();
        assert.ok(app.rendered.length > 0);
        assert.ok(app.rendered.every(data => data.nodes[0].id.startsWith('https://new.example')));
        await app.window.renderGraph(graphData('https://third.example'));
        app.flushFrames();
        assert.equal(app.scripts().length, 1, 'the loaded library is reused');
        assert.ok(app.rendered.at(-1).nodes[0].id.startsWith('https://third.example'));
    });

    test('a failed library load leaves validation usable and a later validation can retry', async t => {
        const app = harness(t);
        const failed = app.window.renderGraph(graphData('https://first.example'));
        app.scripts()[0].dispatchEvent(new app.window.Event('error'));
        await failed;
        assert.equal(app.scripts().length, 0);
        assert.match(app.window.document.getElementById('graphSummary').textContent, /nicht verfügbar/);
        assert.match(app.window.document.getElementById('graphContext').textContent, /Validierung und XML-Ansicht bleiben verfügbar/);
        assert.equal(app.rendered.length, 0);
        const retry = app.window.renderGraph(graphData('https://retry.example'));
        assert.equal(app.scripts().length, 1);
        app.provideLibrary();
        await retry;
        app.flushFrames();
        assert.ok(app.rendered.at(-1).nodes[0].id.startsWith('https://retry.example'));
        assert.equal(app.window.document.getElementById('rdfGraph3d').classList.contains('d-none'), false);
    });

    test('resetting validation while loading or before drawing prevents an outdated graph from appearing', async t => {
        const app = harness(t);
        const pending = app.window.renderGraph(graphData('https://outdated.example'));
        app.window.hideGraph();
        app.provideLibrary();
        await pending;
        app.flushFrames();
        assert.equal(app.rendered.length, 0);
        assert.equal(app.window.document.getElementById('graphPanel').classList.contains('d-none'), true);

        await app.window.renderGraph(graphData('https://also-outdated.example'));
        app.window.hideGraph();
        app.flushFrames();
        assert.equal(app.rendered.length, 0);
        assert.equal(app.window.document.getElementById('graphPanel').classList.contains('d-none'), true);
    });
}
