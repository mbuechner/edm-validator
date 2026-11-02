// Optional DOM tests: npm ci; npm run build
// Run: node --test src/test/js/graph-module.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
const assets = path.join(root, 'target/frontend');
const threeVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies.three;
let JSDOM;
try { ({ JSDOM } = require(path.join(root, 'node_modules/jsdom'))); }
catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
const domTestOptions = {
    skip: JSDOM ? false : 'Run npm ci and npm run build before DOM tests.'
};
const bundlePath = path.join(assets, 'vendor/graph.mjs');
const nodesPath = path.join(assets, 'graph-nodes.js');

function loadSymbols(window, timers = { setTimeout, clearTimeout }) {
    const context = vm.createContext({
        window, document: window.document, URL,
        setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout
    });
    vm.runInContext(fs.readFileSync(nodesPath, 'utf8'), context, {
        filename: nodesPath,
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
    });
    return window.RdfGraphNodes;
}

test('renderer and custom symbols load the same local Three module without duplicate-instance warnings', domTestOptions, async () => {
    const dom = new JSDOM('<!doctype html>', { url: pathToFileURL(nodesPath).href });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    const warnings = [];
    const previousWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); previousWarn(...args); };
    try {
        const symbols = loadSymbols(dom.window);
        const pending = symbols.load();
        assert.equal(symbols.load(), pending, 'concurrent callers share the import');
        const library = await pending;
        const shared = await import(pathToFileURL(bundlePath).href);
        assert.equal(library.createGraph, shared.default, 'the renderer is the bundle default export');
        const mesh = library.nodeFactory.create({ classes: ['ProvidedCHO'], degree: 2 });
        assert.ok(mesh instanceof shared.THREE.Mesh);
        assert.ok(mesh.geometry instanceof shared.THREE.BoxGeometry);
        assert.ok(mesh.material instanceof shared.THREE.MeshBasicMaterial);
        assert.notEqual(mesh.id, new shared.THREE.PerspectiveCamera().id,
            'renderer objects and custom meshes share the Object3D identity counter');
        assert.equal(await symbols.load(), library, 'subsequent renders keep the same factory');
        assert.deepEqual(warnings.filter(value => /multiple instances|three\.warning/i.test(value)), []);
    } finally {
        console.warn = previousWarn;
        delete globalThis.window;
        delete globalThis.document;
        dom.window.close();
    }
});

test('a timed-out module load releases its cache, and its late completion cannot replace a retry', domTestOptions, async () => {
    const dom = new JSDOM('<!doctype html>', { url: pathToFileURL(nodesPath).href });
    const timers = new Map();
    let nextTimer = 0;
    const symbols = loadSymbols(dom.window, {
        setTimeout(callback, delay) {
            assert.equal(delay, 30000);
            timers.set(++nextTimer, callback);
            return nextTimer;
        },
        clearTimeout(id) { timers.delete(id); }
    });
    try {
        const abandoned = symbols.load();
        timers.get(1)(); // Exercise the real deadline without waiting 30 seconds.
        await assert.rejects(abandoned, /30 Sekunden/);
        const retry = symbols.load();
        assert.notEqual(retry, abandoned);
        const loaded = await retry;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(await symbols.load(), loaded);
        assert.equal(timers.size, 0, 'both settled attempts release their deadline');
    } finally {
        dom.window.close();
    }
});

test('the reproducible bundle contains one Three package and no runtime module dependencies', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'target/frontend/vendor/graph-manifest.json'), 'utf8'));
    const threePackages = manifest.packages.filter(value => value.name === 'three');
    assert.equal(threePackages.length, 1, 'the renderer and symbols share exactly one installed Three package');
    assert.equal(threePackages[0].version, threeVersion);
    assert.ok(manifest.threeInputs.length > 0, 'the shared Three implementation is bundled locally');
    assert.deepEqual(manifest.imports, [], 'all renderer and control imports are local in the bundle');
    assert.equal(createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex'), manifest.sha256);
});
