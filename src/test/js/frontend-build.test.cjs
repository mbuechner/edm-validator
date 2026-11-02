// Run npm ci and npm run build before executing the generated-asset checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const assets = path.join(root, 'target/frontend');
const readJson = filename => JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8'));

test('runtime packages have exact versions and integrity records in the npm lockfile', () => {
    const packageJson = readJson('package.json');
    const lock = readJson('package-lock.json');
    for (const name of ['3d-force-graph', 'three', 'bootstrap', 'prismjs', 'oxigraph', 'saxes']) {
        const version = packageJson.dependencies[name];
        const installed = lock.packages['node_modules/' + name];
        assert.match(version, /^\d+\.\d+\.\d+$/, name + ' must use an exact runtime version');
        assert.equal(installed.version, version, name + ' must match its lockfile');
        assert.match(installed.integrity, /^sha512-/, name + ' must have a verified package archive');
    }
});

test('generated distributables are copied from the installed npm packages', () => {
    for (const [output, input] of [
        ['vendor/bootstrap/bootstrap.min.css', 'bootstrap/dist/css/bootstrap.min.css'],
        ['vendor/bootstrap/bootstrap.bundle.min.js', 'bootstrap/dist/js/bootstrap.bundle.min.js'],
        ['vendor/prism-core.min.js', 'prismjs/components/prism-core.min.js'],
        ['vendor/prism-markup.min.js', 'prismjs/components/prism-markup.min.js'],
        ['vendor/prism-json.min.js', 'prismjs/components/prism-json.min.js'],
        ['vendor/oxigraph/oxigraph.mjs', 'oxigraph/web.js'],
        ['vendor/oxigraph/web_bg.wasm', 'oxigraph/web_bg.wasm']
    ]) {
        assert.deepEqual(fs.readFileSync(path.join(assets, output)),
            fs.readFileSync(path.join(root, 'node_modules', input)), output + ' must match its npm source');
    }
});

test('browser library binaries are generated outside the application source directory', () => {
    const vendor = path.join(root, 'src/main/resources/static/vendor');
    const runtimeFiles = directory => !fs.existsSync(directory) ? [] : fs.readdirSync(directory, { withFileTypes: true })
        .flatMap(entry => entry.isDirectory() ? runtimeFiles(path.join(directory, entry.name))
            : /\.(?:m?js|wasm)$/.test(entry.name) ? [entry.name] : []);
    assert.deepEqual(runtimeFiles(vendor), [], 'source control contains no copied library executables');
    assert.ok(fs.statSync(path.join(assets, 'vendor/graph.mjs')).isFile());
    assert.ok(fs.statSync(path.join(assets, 'vendor/saxes/saxes.mjs')).isFile());
});

test('every application library reference uses a stable URL that resolves in the generated frontend', () => {
    const applicationFiles = directory => fs.readdirSync(directory, { withFileTypes: true })
        .flatMap(entry => entry.isDirectory() ? entry.name === 'vendor' ? [] : applicationFiles(path.join(directory, entry.name))
            : /\.(?:html|m?js)$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
    const references = new Set();
    for (const filename of applicationFiles(assets)) {
        const source = fs.readFileSync(filename, 'utf8');
        for (const match of source.matchAll(/(['"])(\.\/vendor\/[^'"\s]+)\1/g)) {
            const reference = match[2];
            references.add(reference);
            assert.doesNotMatch(reference, /\d+\.\d+\.\d+/, 'library URLs must not embed dependency versions');
            assert.ok(fs.statSync(path.resolve(path.dirname(filename), reference)).isFile(),
                path.relative(assets, filename) + ': ' + reference + ' must resolve after a dependency update');
        }
    }
    assert.ok(references.size > 0, 'the generated application exercises actual local library references');
});
