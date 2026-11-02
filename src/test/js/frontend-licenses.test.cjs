const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../../..');
const temporaryRoot = path.join(root, 'target');
const fallbackRoot = path.join(root, 'tools/frontend/licenses');
const readFallback = filename => fs.readFileSync(path.join(fallbackRoot, filename), 'utf8').replace(/\r\n?/g, '\n');

async function readLicense(directory, filenames) {
    const { readPackageLicense } = await import(pathToFileURL(path.join(root, 'tools/frontend/licenses.mjs')).href);
    return readPackageLicense(directory, filenames);
}

function packageFixture(t, metadata, files = {}) {
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'package-license-test-'));
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(metadata));
    for (const [filename, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, filename), content);
    t.after(() => {
        assert.equal(path.dirname(path.resolve(directory)), temporaryRoot, 'cleanup is confined to the generated test directory');
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

test('a newer saxes package with unchanged SPDX licensing can use the checked-in license text', async t => {
    const directory = packageFixture(t, { name: 'saxes', version: '999.0.0', license: 'ISC' });
    assert.equal(await readLicense(directory), readFallback('saxes/LICENSE'));
});

test('a package-provided license takes precedence over fallback metadata', async t => {
    const current = 'License supplied by the installed package.\n';
    const directory = packageFixture(t, { name: 'saxes', version: '999.0.0', license: 'MIT' }, { LICENSE: current });
    assert.equal(await readLicense(directory), current);
});

test('a changed SPDX license cannot silently reuse fallback text', async t => {
    const directory = packageFixture(t, { name: 'saxes', version: '999.0.0', license: 'MIT' });
    await assert.rejects(readLicense(directory), /No matching license/);
});

test('a newer Oxigraph package retains both fallback licenses without a version-specific directory', async t => {
    const directory = packageFixture(t, { name: 'oxigraph', version: '999.0.0', license: 'MIT OR Apache-2.0' });
    const mit = readFallback('oxigraph/LICENSE-MIT');
    const apache = readFallback('oxigraph/LICENSE-APACHE');
    assert.equal(await readLicense(directory, ['LICENSE-MIT']), mit);
    assert.equal(await readLicense(directory, ['LICENSE-APACHE']), apache);
    const combined = await readLicense(directory);
    assert.ok(combined.includes(mit.trim()), 'the default fallback includes the complete MIT license');
    assert.ok(combined.includes(apache.trim()), 'the default fallback includes the complete Apache license');
});
