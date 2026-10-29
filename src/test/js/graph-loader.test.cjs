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
    test('Graph explorer DOM tests', {
        skip: 'Install optional test tools: npm install --no-save --prefix target/ui-check jsdom@26.1.0'
    }, () => {});
}

if (JSDOM) {
    const html = fs.readFileSync(path.join(root, 'src/main/resources/static/explorer.html'), 'utf8');
    const source = fs.readFileSync(path.join(root, 'src/main/resources/static/graph.js'), 'utf8');
    const fitSource = fs.readFileSync(path.join(root, 'src/main/resources/static/graph-fit.js'), 'utf8');
    const nodesSource = fs.readFileSync(path.join(root, 'src/main/resources/static/graph-nodes.js'), 'utf8');
    const stylesheet = fs.readFileSync(path.join(root, 'src/main/resources/static/graph.css'), 'utf8');
    const libraryUrl = './vendor/3d-force-graph-1.80.0.min.js';
    let THREE;
    test.before(async () => {
        const source = fs.readFileSync(path.join(root, 'src/main/resources/static/vendor/three-core-0.183.2.min.js'), 'utf8');
        THREE = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    });
    function graphData(prefix = 'https://example.org') {
        return {
            graphNodes: [
                { id: prefix + '/record', label: 'Datensatz', nodeType: 'IRI', classes: ['ProvidedCHO'] },
                { id: prefix + '/image', label: 'Bildansicht', nodeType: 'IRI', classes: ['WebResource'] },
                { id: 'literal:Eine historische Aufnahme', label: 'Eine historische Aufnahme', nodeType: 'Literal', classes: [] },
                { id: prefix + '/other', label: 'Andere Ressource', nodeType: 'IRI', classes: [] },
                { id: prefix + '/collection', label: 'Sammlung', nodeType: 'IRI', classes: ['Collection'] },
                { id: 'http://www.europeana.eu/schemas/edm/ProvidedCHO', label: 'ProvidedCHO', nodeType: 'IRI', classes: [] }
            ],
            graphLinks: [
                { source: prefix + '/record', target: prefix + '/image', predicate: 'isShownBy', predicateUri: 'http://www.europeana.eu/schemas/edm/isShownBy' },
                { source: prefix + '/record', target: 'literal:Eine historische Aufnahme', predicate: 'title', predicateUri: 'http://purl.org/dc/elements/1.1/title' },
                { source: prefix + '/other', target: prefix + '/collection', predicate: 'related', predicateUri: 'http://example.org/related' },
                { source: prefix + '/record', target: 'http://www.europeana.eu/schemas/edm/ProvidedCHO', predicate: 'type', predicateUri: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' }
            ]
        };
    }

    function harness(t, { nativeFullscreen = false, rejectFullscreen = false, reducedMotion = true, deferMeshes = false } = {}) {
        const dom = new JSDOM(html, { url: 'https://validator.example/', runScripts: 'outside-only' });
        const { window } = dom;
        const document = window.document;
        const style = document.createElement('style');
        style.textContent = stylesheet;
        document.head.append(style);
        const frames = new Map();
        const rendered = [];
        const meshBuilders = [];
        const calls = [];
        const settings = new Map();
        const observers = [];
        const size = { width: 1100, height: 620 };
        let frameId = 0;
        let currentData = { nodes: [], links: [] };
        let fullscreenElement = null;
        let enterCount = 0;
        let exitCount = 0;
        const controlEvents = new Map();
        const camera = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 10000);
        camera.position.set(0, 0, 300);
        let zoomMomentum = 0;
        const controls = {
            staticMoving: false,
            target: new THREE.Vector3(),
            update() {
                if (zoomMomentum) {
                    camera.position.sub(this.target).multiplyScalar(1 + zoomMomentum).add(this.target);
                    zoomMomentum = this.staticMoving ? 0 : zoomMomentum * 0.8;
                }
                camera.lookAt(this.target);
                camera.updateMatrixWorld(true);
            },
            reset() { camera.position.set(0, 0, 300); this.target.set(0, 0, 0); },
            simulateWheelZoom(delta) {
                controlEvents.get('start')?.();
                zoomMomentum = delta;
                this.update();
            },
            addEventListener(name, handler) { controlEvents.set(name, handler); },
            removeEventListener() {}
        };
        controls.update();
        const renderer = {
            domElement: document.createElement('canvas'),
            setPixelRatio() {},
            setSize(width, height) {
                this.domElement.width = width;
                this.domElement.height = height;
                calls.push({ method: 'renderer.setSize', args: [width, height] });
            }
        };
        const force = new Proxy({}, { get() { return () => force; } });
        const graph = new Proxy({}, { get(_target, property) {
            return (...args) => {
                if (property === 'controls') return controls;
                if (property === 'renderer') return renderer;
                if (property === 'camera') return camera;
                if (property === 'scene') return { add() {}, remove() {} };
                if (property === 'graph2ScreenCoords') {
                    const point = new THREE.Vector3(...args).project(camera);
                    return { x: (point.x + 1) * size.width / 2, y: (1 - point.y) * size.height / 2 };
                }
                if (property === 'd3Force' && args.length === 1) return force;
                if (!args.length && property === 'graphData') return currentData;
                if (!args.length && property === 'cameraPosition') return { ...camera.position };
                if (!args.length && settings.has(property)) return settings.get(property);
                calls.push({ method: property, args });
                if (args.length) settings.set(property, args[0]);
                if (property === 'graphData') {
                    currentData = args[0];
                    currentData.nodes.forEach((node, index) => {
                        node.x ??= index * 25 + 10;
                        node.y ??= index * 10;
                        node.z ??= index * 15;
                        const create = settings.get('nodeThreeObject');
                        if (typeof create === 'function') {
                            const build = () => { node.__threeObj = create(node); };
                            if (deferMeshes) meshBuilders.push(build);
                            else build();
                        }
                    });
                    rendered.push(currentData);
                }
                return graph;
            };
        } });
        window.matchMedia = () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} });
        window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
        window.cancelAnimationFrame = id => frames.delete(id);
        window.ResizeObserver = class {
            constructor(callback) { observers.push(callback); }
            observe() {}
            disconnect() {}
        };
        for (const id of ['graphStage', 'rdfGraph3d']) {
            const element = document.getElementById(id);
            if (!element) continue;
            element.getBoundingClientRect = () => ({ ...size, top: 0, left: 0, right: size.width, bottom: size.height });
            Object.defineProperty(element, 'clientWidth', { get: () => size.width });
            Object.defineProperty(element, 'clientHeight', { get: () => size.height });
        }
        if (nativeFullscreen) {
            Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true });
            Object.defineProperty(document, 'fullscreenElement', { get: () => fullscreenElement, configurable: true });
            document.getElementById('graphPanel').requestFullscreen = async () => {
                enterCount++;
                if (rejectFullscreen) throw new Error('Fullscreen denied');
                fullscreenElement = document.getElementById('graphPanel');
                document.dispatchEvent(new window.Event('fullscreenchange'));
            };
            document.exitFullscreen = async () => {
                exitCount++;
                fullscreenElement = null;
                document.dispatchEvent(new window.Event('fullscreenchange'));
            };
        }
        window.eval(fitSource);
        window.eval(nodesSource);
        const nodeFactory = window.RdfGraphNodes.createFactory(THREE);
        window.RdfGraphNodes = { ...window.RdfGraphNodes, load: async () => nodeFactory };
        window.eval(source);
        const explorer = window.RdfGraphExplorer;
        const scripts = () => [...document.querySelectorAll(`script[src="${libraryUrl}"]`)];
        const provideLibrary = () => {
            window.ForceGraph3D = () => () => graph;
            const script = scripts()[0];
            if (script) script.dispatchEvent(new window.Event('load'));
        };
        const flushFrames = () => {
            for (let count = 0; frames.size; count++) {
                assert.ok(count < 100, 'graph updates must not create an unbounded animation-frame loop');
                const pending = [...frames];
                frames.clear();
                pending.forEach(([, callback]) => callback(0));
            }
        };
        const flushFrame = () => {
            const pending = [...frames];
            frames.clear();
            pending.forEach(([, callback]) => callback(0));
        };
        const ready = async data => {
            const pending = explorer.render(data || graphData());
            provideLibrary();
            await pending;
            flushFrames();
        };
        const input = (id, value) => {
            const element = document.getElementById(id);
            element.value = value;
            element.dispatchEvent(new window.Event('input', { bubbles: true }));
        };
        const cameraState = () => ({ position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
            target: controls.target.toArray(), near: camera.near, far: camera.far, aspect: camera.aspect });
        const assertOverview = () => {
            camera.updateMatrixWorld(true);
            for (const node of currentData.nodes) {
                const radius = nodeFactory.radius(node);
                for (const dx of [-radius, radius]) for (const dy of [-radius, radius]) for (const dz of [-radius, radius]) {
                    const point = new THREE.Vector3(node.x + dx, node.y + dy, node.z + dz).project(camera);
                    assert.ok(point.x >= -1 && point.x <= 1 && point.y >= -1 && point.y <= 1
                        && point.z > -1 && point.z < 1,
                    `node ${node.id} and its complete shape must project inside the actual camera viewport`);
                }
            }
        };
        const buildMeshes = (count = meshBuilders.length) => meshBuilders.splice(0, count).forEach(build => build());
        t.after(() => window.close());
        return { window, document, explorer, graph, settings, calls, controls, controlEvents, rendered, scripts, provideLibrary,
            camera, cameraState, assertOverview, nodeFactory, buildMeshes, flushFrame, flushFrames, ready, input, size, observers,
            fullscreenCounts: () => ({ enterCount, exitCount }) };
    }

    test('the graph library loads on demand, pins its version and shares one pending load', async t => {
        const app = harness(t);
        assert.equal(app.scripts().length, 0);
        await app.explorer.render({ graphNodes: [], graphLinks: [] });
        assert.equal(app.scripts().length, 0);
        const older = app.explorer.render(graphData('https://old.example'));
        const newer = app.explorer.render(graphData('https://new.example'));
        assert.equal(app.scripts().length, 1);
        assert.equal(app.scripts()[0].async, true);
        app.provideLibrary();
        await Promise.all([older, newer]);
        app.flushFrames();
        assert.ok(app.rendered.length > 0);
        assert.ok(app.rendered.every(data => data.nodes[0].id.startsWith('https://new.example')));
        const nextDocument = graphData('https://third.example');
        await app.explorer.render(nextDocument);
        app.flushFrames();
        assert.equal(app.scripts().length, 1, 'the loaded library is reused');
        assert.ok(app.rendered.at(-1).nodes[0].id.startsWith('https://third.example'));
        assert.equal(nextDocument.graphNodes[0].x, undefined, 'renderer positions do not modify API response nodes');
    });

    test('a failed library load preserves the source and a later graph can retry', async t => {
        const app = harness(t);
        const failed = app.explorer.render(graphData());
        app.scripts()[0].dispatchEvent(new app.window.Event('error'));
        await failed;
        assert.equal(app.scripts().length, 0);
        assert.match(app.document.getElementById('graphSummary').textContent, /nicht verfügbar/);
        assert.match(app.document.getElementById('graphContext').textContent, /RDF\/XML-Eingabe.*Graph anzeigen/);
        assert.equal(app.rendered.length, 0);
        await app.ready(graphData('https://retry.example'));
        assert.ok(app.rendered.at(-1).nodes[0].id.startsWith('https://retry.example'));
        assert.equal(app.document.getElementById('rdfGraph3d').classList.contains('d-none'), false);
    });

    test('hiding the explorer while loading or before drawing prevents an outdated graph', async t => {
        const app = harness(t);
        const pending = app.explorer.render(graphData());
        app.explorer.hide();
        app.provideLibrary();
        await pending;
        app.flushFrames();
        assert.equal(app.rendered.length, 0);
        assert.equal(app.document.getElementById('graphPanel').classList.contains('d-none'), true);
        await app.explorer.render(graphData());
        app.explorer.hide();
        app.flushFrames();
        assert.equal(app.rendered.length, 0);
        assert.equal(app.document.getElementById('graphPanel').classList.contains('d-none'), true);
    });

    test('native fullscreen updates its accessible state, restores focus and does not reload graph data', async t => {
        const app = harness(t, { nativeFullscreen: true });
        await app.ready();
        const button = app.document.getElementById('fullscreenGraphBtn');
        button.focus();
        const renders = app.rendered.length;
        await app.explorer.toggleFullscreen();
        app.flushFrames();
        assert.equal(app.document.fullscreenElement, app.document.getElementById('graphPanel'));
        assert.equal(button.getAttribute('aria-expanded'), 'true');
        await app.explorer.toggleFullscreen();
        app.flushFrames();
        assert.equal(app.document.fullscreenElement, null);
        assert.equal(button.getAttribute('aria-expanded'), 'false');
        assert.equal(app.document.activeElement, button);
        assert.deepEqual(app.fullscreenCounts(), { enterCount: 1, exitCount: 1 });
        assert.equal(app.rendered.length, renders, 'fullscreen resizes the renderer without rebuilding the graph');

        await app.explorer.toggleFullscreen();
        await app.document.exitFullscreen(); // The browser's Escape action produces the same event.
        app.flushFrames();
        assert.equal(button.getAttribute('aria-expanded'), 'false');
        assert.equal(app.document.activeElement, button);

        const panel = app.document.getElementById('graphPanel');
        const nativeEnter = panel.requestFullscreen;
        let completeNativeEntry;
        panel.requestFullscreen = () => new Promise(resolve => {
            completeNativeEntry = async () => { await nativeEnter(); resolve(); };
        });
        const entering = app.explorer.toggleFullscreen();
        app.explorer.hide();
        await completeNativeEntry();
        await entering;
        app.flushFrames();
        assert.equal(app.document.fullscreenElement, null, 'a delayed entry cannot leave a hidden graph fullscreen');
        assert.equal(panel.classList.contains('graph-fullscreen'), false);
        assert.equal(app.document.body.classList.contains('graph-fullscreen-open'), false);
    });

    test('fullscreen has an Escape-enabled fallback and hide restores scrolling even after API rejection', async t => {
        for (const rejectFullscreen of [false, true]) {
            const app = harness(t, { nativeFullscreen: rejectFullscreen, rejectFullscreen });
            await app.ready();
            const panel = app.document.getElementById('graphPanel');
            const button = app.document.getElementById('fullscreenGraphBtn');
            app.document.body.style.overflow = 'auto';
            button.focus();
            await app.explorer.toggleFullscreen();
            assert.equal(panel.classList.contains('graph-fullscreen'), true);
            assert.equal(app.document.body.classList.contains('graph-fullscreen-open'), true);
            assert.equal(button.getAttribute('aria-expanded'), 'true');
            app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await Promise.resolve();
            app.flushFrames();
            assert.equal(panel.classList.contains('graph-fullscreen'), false);
            assert.equal(app.document.body.classList.contains('graph-fullscreen-open'), false);
            assert.equal(app.document.body.style.overflow, 'auto');
            assert.equal(app.document.activeElement, button);
            await app.explorer.toggleFullscreen();
            await app.explorer.hide();
            assert.equal(panel.classList.contains('graph-fullscreen'), false);
            assert.equal(app.document.body.classList.contains('graph-fullscreen-open'), false);
            assert.equal(panel.classList.contains('d-none'), true);
        }
    });

    test('search, class selection and relationship navigation show details without changing the view', async t => {
        const app = harness(t, { reducedMotion: false });
        await app.ready();
        const overview = app.cameraState();
        app.input('graphSearch', 'bildansicht');
        const result = app.document.querySelector('#graphSearchResults button.graph-search-result');
        assert.ok(result);
        assert.match(result.textContent, /Bildansicht/);
        result.click();
        assert.match(app.document.getElementById('graphNodeTitle').textContent, /Bildansicht/);
        assert.match(app.document.getElementById('graphContext').textContent, /https:\/\/example.org\/image/);
        assert.equal(app.document.getElementById('graphIncomingCount').textContent.trim(), '1');
        assert.equal(app.document.getElementById('graphOutgoingCount').textContent.trim(), '0');
        assert.deepEqual(app.cameraState(), overview, 'search selection preserves the current camera and zoom');
        assert.ok(app.document.querySelector('#graphConnections button.graph-connection'));
        app.input('graphSearch', 'historische');
        assert.ok(app.document.querySelector('#graphSearchResults button.graph-search-result'),
            'literal values remain searchable without enabling a filter');
        app.input('graphSearch', 'ProvidedCHO');
        assert.ok(app.document.querySelector('#graphSearchResults button.graph-search-result'),
            'RDF classes remain discoverable through the same search');
        const classNode = app.rendered.at(-1).nodes.find(node => node.id === 'http://www.europeana.eu/schemas/edm/ProvidedCHO');
        const classEdge = app.rendered.at(-1).links.find(link => link.predicate === 'type');
        const classWidthBeforeSelection = app.settings.get('linkWidth')(classEdge);
        app.settings.get('onNodeClick')(classNode);
        assert.equal(app.document.getElementById('graphContext').textContent, classNode.id);
        assert.ok(app.settings.get('linkWidth')(classEdge) > classWidthBeforeSelection,
            'selecting a class highlights its relationship without requiring a camera move');
        assert.deepEqual(app.cameraState(), overview, 'clicking an RDF class preserves the current camera and zoom');
        const record = app.rendered.at(-1).nodes.find(node => node.id.endsWith('/record'));
        app.settings.get('onNodeClick')(record);
        assert.deepEqual(app.cameraState(), overview, 'resource selection preserves the current camera and zoom');
        const titleConnection = () => [...app.document.querySelectorAll('#graphConnections button.graph-connection')]
            .find(button => button.querySelector('.graph-connection-predicate').textContent.includes('title'));
        assert.equal(titleConnection().disabled, false);
        const imageConnection = [...app.document.querySelectorAll('#graphConnections button.graph-connection')]
            .find(button => button.querySelector('.graph-connection-predicate').textContent.includes('isShownBy'));
        imageConnection.click();
        assert.match(app.document.getElementById('graphNodeTitle').textContent, /Bildansicht/);
        assert.deepEqual(app.cameraState(), overview, 'following a relationship preserves the current camera and zoom');
        app.settings.get('onEngineStop')();
        app.flushFrames();
        assert.deepEqual(app.cameraState(), overview, 'a late layout completion cannot override a selected node');

        const manyMatches = graphData();
        for (let i = 0; i < 12; i++) {
            const id = 'https://example.org/result/' + i;
            manyMatches.graphNodes.push({ id, label: 'Treffer ' + i, nodeType: 'IRI', classes: [] });
            manyMatches.graphLinks.push({ source: manyMatches.graphNodes[0].id, target: id, predicate: 'related' });
        }
        await app.ready(manyMatches);
        app.input('graphSearch', 'treffer');
        assert.equal(app.document.querySelectorAll('#graphSearchResults button.graph-search-result').length, 8,
            'search remains a bounded, usable result list');
    });

    test('a document starts in a fitted overview and a settled layout never overrides user exploration', async t => {
        const app = harness(t, { reducedMotion: false });
        await app.ready();
        assert.equal(app.camera.aspect, app.size.width / app.size.height, 'the camera uses the measured viewport aspect');
        assert.deepEqual(app.calls.find(call => call.method === 'renderer.setSize').args, [app.size.width, app.size.height],
            'the renderer drawing surface is resized synchronously for the opening frame');
        app.assertOverview();
        assert.equal(app.document.getElementById('rdfGraph3d').style.visibility, '', 'the opening view is revealed after fitting');
        assert.equal(app.document.getElementById('clearGraphFocusBtn').classList.contains('d-none'), true);
        assert.equal(app.settings.get('cooldownTicks'), 0, 'the opening layout settles before the first visible frame');
        assert.ok(app.settings.get('warmupTicks') >= 100, 'the graph warms up before it is fitted');
        assert.equal(app.settings.get('enableNodeDrag'), false, 'accidental node dragging cannot move a node outside the overview');
        assert.equal(app.controls.staticMoving, true, 'camera controls disable momentum before the first interaction');
        app.settings.get('onEngineStop')();
        app.flushFrames();
        app.assertOverview();
        app.controls.simulateWheelZoom(-0.15);
        app.explorer.resetView();
        const resetOverview = app.cameraState();
        app.controls.update();
        assert.deepEqual(app.cameraState(), resetOverview, 'a reset overview does not drift from residual zoom momentum');
        app.assertOverview();
        await app.ready(graphData('https://exploring.example'));
        app.controlEvents.get('start')();
        app.camera.position.set(30, 20, 600);
        app.controls.target.set(10, 5, 0);
        app.controls.update();
        app.controls.simulateWheelZoom(-0.15);
        const explored = app.cameraState();
        app.settings.get('onEngineStop')();
        app.flushFrames();
        assert.deepEqual(app.cameraState(), explored, 'automatic fitting stops when the user manipulates the camera');
        app.settings.get('onNodeClick')(app.rendered.at(-1).nodes[0]);
        assert.deepEqual(app.cameraState(), explored, 'selection does not move the actual camera');
        await app.explorer.render(graphData('https://next.example'));
        app.settings.get('onEngineStop')(); // A late stop event from the preceding layout.
        assert.deepEqual(app.cameraState(), explored,
            'the preceding layout cannot fit a document whose canvas data is not installed yet');
        app.flushFrames();
        assert.equal(app.document.getElementById('clearGraphFocusBtn').classList.contains('d-none'), true);
        app.assertOverview();
        assert.notDeepEqual(app.cameraState(), explored, 'a new document restores its own complete overview');
        const newOverview = app.cameraState();
        app.controls.update();
        assert.deepEqual(app.cameraState(), newOverview, 'a new document does not inherit residual zoom momentum');
    });

    test('the opening fit reads current coordinates before stale rendered bounds and waits for a usable viewport', async t => {
        const app = harness(t);
        const pending = app.explorer.render(graphData());
        app.provideLibrary();
        await pending;
        app.flushFrame();
        const nodes = app.rendered.at(-1).nodes;
        nodes.forEach((node, index) => {
            node.x = index * 470 - 1300;
            node.y = index % 2 ? -800 : 1200;
            node.z = index * 920 - 2100;
        });
        app.flushFrames();
        app.assertOverview();

        const hidden = harness(t);
        hidden.size.width = 0;
        hidden.size.height = 0;
        await hidden.ready();
        assert.equal(hidden.document.getElementById('rdfGraph3d').style.visibility, 'hidden');
        hidden.size.width = 320;
        hidden.size.height = 640;
        hidden.observers.forEach(callback => callback([]));
        hidden.flushFrames();
        assert.equal(hidden.document.getElementById('rdfGraph3d').style.visibility, '');
        assert.equal(hidden.camera.aspect, 0.5);
        hidden.assertOverview();
    });

    test('only completed symbols for the current document can reveal its initial overview', async t => {
        const app = harness(t, { deferMeshes: true });
        await app.ready(graphData('https://old.example'));
        const canvas = app.document.getElementById('rdfGraph3d');
        assert.equal(canvas.style.visibility, 'hidden', 'a canvas with pending scene creation stays concealed');
        app.controlEvents.get('start')();
        app.settings.get('onEngineStop')();
        app.flushFrames();
        assert.equal(canvas.style.visibility, 'hidden', 'an early engine event or gesture cannot expose an unfinished view');

        await app.ready(graphData('https://new.example'));
        app.buildMeshes(graphData().graphNodes.length); // Complete only the superseded document's symbols.
        app.settings.get('onEngineStop')();
        app.flushFrames();
        assert.equal(canvas.style.visibility, 'hidden', 'stale symbol callbacks cannot complete the current document');
        app.buildMeshes();
        app.settings.get('onEngineStop')();
        app.flushFrames();
        assert.equal(canvas.style.visibility, '');
        assert.ok(app.rendered.at(-1).nodes[0].id.startsWith('https://new.example'));
        app.assertOverview();
    });

    test('labels start hidden and can be removed without returning after hover, selection or resizing', async t => {
        const app = harness(t);
        await app.ready();
        const checkbox = app.document.getElementById('graphLabelsToggle');
        const labels = () => [...app.document.querySelectorAll('#graphLabels .graph-node-label')];
        assert.ok(checkbox, 'one direct switch controls optional labels');
        assert.equal(checkbox.checked, false);
        assert.equal(labels().length, 0);
        checkbox.checked = true;
        checkbox.dispatchEvent(new app.window.Event('change', { bubbles: true }));
        app.flushFrames();
        assert.ok(labels().length > 0 && labels().length <= 6, 'optional labels remain sparse');
        assert.ok(labels().some(label => !label.hidden), 'enabling labels exposes a readable resource label');
        assert.ok(labels().every(label => label.tagName !== 'BUTTON'), 'labels do not add clickable graph obstructions');
        assert.equal(app.window.getComputedStyle(app.document.getElementById('graphLabels')).pointerEvents, 'none');

        checkbox.checked = false;
        checkbox.dispatchEvent(new app.window.Event('change', { bubbles: true }));
        assert.equal(labels().length, 0);
        const node = app.rendered.at(-1).nodes[0];
        app.settings.get('onNodeHover')(node);
        app.settings.get('onNodeClick')(node);
        app.settings.get('onEngineTick')();
        app.window.dispatchEvent(new app.window.Event('resize'));
        app.flushFrames();
        assert.equal(labels().length, 0, 'disabled labels do not reappear during exploration');

        checkbox.checked = true;
        checkbox.dispatchEvent(new app.window.Event('change', { bubbles: true }));
        await app.ready(graphData('https://next.example'));
        assert.equal(checkbox.checked, false, 'each document opens with an unobstructed overview');
        assert.equal(labels().length, 0);
    });

    test('the light overview distinguishes resource and RDF-type relationships from literal values', async t => {
        const app = harness(t);
        await app.ready();
        const background = app.settings.get('backgroundColor');
        const swatch = app.document.createElement('div');
        swatch.style.backgroundColor = background;
        app.document.body.append(swatch);
        const rgb = app.window.getComputedStyle(swatch).backgroundColor.match(/[\d.]+/g).slice(0, 3).map(Number);
        assert.ok(rgb.every(component => component >= 240), 'the graph starts on a light canvas');
        const current = app.rendered.at(-1);
        const relation = current.links.find(link => link.predicate === 'isShownBy');
        const type = current.links.find(link => link.predicate === 'type');
        const literal = current.links.find(link => link.predicate === 'title');
        const value = (setting, link) => typeof setting === 'function' ? setting(link) : setting;
        const width = app.settings.get('linkWidth');
        assert.ok(value(width, relation) > value(width, literal), 'resource relations stand out from literal attachments');
        assert.ok(value(width, type) > value(width, literal), 'rdf:type connections stay visible');
        assert.ok(value(app.settings.get('linkDirectionalArrowLength'), relation) > 0,
            'arrows make the direction of RDF relationships visible');
        const record = current.nodes.find(node => node.classes.includes('ProvidedCHO'));
        assert.match(app.settings.get('nodeLabel')(record).textContent, /ProvidedCHO/,
            'resource tooltips expose their RDF class');
    });

    test('literal names and search use the complete lexical label rather than encoded identity keys', async t => {
        const app = harness(t);
        const data = graphData();
        const text = 'https://example.org/' + 'long-path/'.repeat(12) + 'München & Straße am Schluss';
        const literal = data.graphNodes[2];
        const oldId = literal.id;
        literal.id = 'literal:"' + text + '"@de';
        literal.label = text;
        data.graphLinks.find(link => link.target === oldId).target = literal.id;
        await app.ready(data);
        const current = app.rendered.at(-1);
        const displayed = current.nodes.find(node => node.id === literal.id);
        const record = current.nodes.find(node => node.classes.includes('ProvidedCHO'));
        assert.equal(displayed.displayLabel, text);
        assert.equal(record.displayLabel, text, 'resource names use the label literal, too');
        const tooltip = app.settings.get('nodeLabel')(displayed).textContent;
        assert.ok(tooltip.includes(text));
        assert.equal(tooltip.includes('literal:'), false);
        app.input('graphSearch', 'München & Straße am Schluss');
        const result = [...app.document.querySelectorAll('#graphSearchResults button')].find(button => button.title === text);
        assert.ok(result, 'the suffix beyond the old 58-character ID display remains searchable');
        result.click();
        assert.equal(app.document.getElementById('graphNodeTitle').textContent, text);
        assert.equal(app.document.getElementById('graphContext').textContent, '');
        assert.equal(literal.displayLabel, undefined, 'API response nodes remain untouched');
    });

    test('empty lexical labels are explicit and missing legacy labels still have a readable fallback', async t => {
        const app = harness(t);
        const data = graphData();
        const literal = data.graphNodes[2];
        const oldId = literal.id;
        literal.id = 'literal:""';
        literal.label = '';
        data.graphLinks.find(link => link.target === oldId).target = literal.id;
        await app.ready(data);
        const empty = app.rendered.at(-1).nodes.find(node => node.id === literal.id);
        app.settings.get('onNodeClick')(empty);
        assert.equal(app.document.getElementById('graphNodeTitle').textContent, '(leer)');
        assert.match(app.settings.get('nodeLabel')(empty).textContent, /^\(leer\)/);
        const legacy = graphData();
        delete legacy.graphNodes[2].label;
        await app.explorer.render(legacy);
        app.flushFrames();
        assert.equal(app.rendered.at(-1).nodes.find(node => node.nodeType === 'Literal').displayLabel, 'Eine historische Aufnahme');
    });

    test('node hover emphasizes only adjacent edges and inspector/tooltips keep RDF markup inert', async t => {
        const app = harness(t);
        const data = graphData();
        const raw = '<img src=x onerror="window.rdfMarkupExecuted=true">';
        data.graphNodes[0].label = raw;
        data.graphNodes[0].id += raw;
        data.graphNodes[2].id = 'literal:' + raw;
        data.graphNodes[2].label = raw;
        data.graphLinks[0].source = data.graphNodes[0].id;
        data.graphLinks[1].source = data.graphNodes[0].id;
        data.graphLinks[1].target = data.graphNodes[2].id;
        data.graphLinks[0].predicate = raw;
        data.graphLinks[0].predicateUri = 'https://example.org/' + raw;
        await app.ready(data);
        const current = app.rendered.at(-1);
        const selected = current.nodes.find(node => node.label === raw);
        const adjacent = current.links.find(link => link.predicate === raw);
        const unrelated = current.links.find(link => link.predicate === 'related');
        app.document.getElementById('clearGraphFocusBtn').click();
        app.settings.get('onNodeHover')(selected);
        assert.ok(app.settings.get('linkWidth')(adjacent) > app.settings.get('linkWidth')(unrelated));
        app.settings.get('onNodeHover')(null);
        app.settings.get('onNodeClick')(selected);
        assert.equal(app.document.getElementById('graphNodeTitle').textContent, raw);
        assert.equal(app.document.getElementById('graphPanel').querySelectorAll('img, script[onerror]').length, 0);
        for (const [accessor, value] of [['nodeLabel', selected], ['linkLabel', adjacent]]) {
            const label = app.settings.get(accessor)(value);
            const element = app.document.createElement('div');
            if (typeof label === 'string') element.innerHTML = label;
            else if (label) element.append(label);
            assert.equal(element.querySelectorAll('img, script, [onerror]').length, 0, accessor);
            assert.match(element.textContent, /img/);
        }
        assert.equal(app.window.rdfMarkupExecuted, undefined);
    });

    test('responsive resizing updates the actual canvas dimensions without resending graph data', async t => {
        const app = harness(t);
        await app.ready();
        const renders = app.rendered.length;
        app.size.width = 640;
        app.size.height = 480;
        app.observers.forEach(callback => callback([{ target: app.document.getElementById('graphStage'),
            contentRect: { ...app.size } }]));
        app.window.dispatchEvent(new app.window.Event('resize'));
        app.flushFrames();
        assert.equal(app.settings.get('width'), 640);
        assert.equal(app.settings.get('height'), 480);
        assert.equal(app.rendered.length, renders);
    });
}
