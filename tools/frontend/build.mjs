import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readPackageLicense } from './licenses.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(root, 'src/main/resources/static');
const output = path.join(root, 'target/frontend');
const vendor = path.join(output, 'vendor');
const dependencies = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).dependencies;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// The generated tree is disposable; never remove a source or arbitrary caller-supplied directory.
if (path.relative(path.join(root, 'target'), output) !== 'frontend') throw new Error('Invalid frontend output directory');
await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true, filter: filename => filename !== path.join(source, 'vendor') });
await mkdir(vendor, { recursive: true });

// Include the shared menu at build time so navigation is present without JavaScript.
const navigation = await readFile(new URL('./fragments/navigation.html', import.meta.url), 'utf8');
const navigationPlaceholder = '    <!-- include: navigation -->';
for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    const html = await readFile(path.join(source, entry.name), 'utf8');
    if (html.split(navigationPlaceholder).length !== 2) {
        throw new Error(`${entry.name} must include the shared navigation exactly once`);
    }
    let activeLinks = 0;
    const menu = navigation.replace(/<a\b[^>]* data-nav-page="([^"]+)"[^>]*>/g, (link, page) => {
        if (page !== entry.name) return link;
        activeLinks++;
        return link.replace('class="', 'aria-current="page" class="active text-white fw-semibold ');
    });
    if (activeLinks !== 1) throw new Error(`${entry.name} must have exactly one navigation link`);
    await writeFile(path.join(output, entry.name), html.replace(navigationPlaceholder,
        menu.trimEnd().split('\n').map(line => '    ' + line).join('\n')));
}

async function copyPackageFile(name, input, destination) {
    const target = path.join(vendor, destination);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, 'node_modules', name, input), target);
}

async function packageInfo(directory) {
    return JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
}

async function bundle(entry, filename, licenseFile) {
    const result = await build({
        absWorkingDir: root,
        entryPoints: [entry], outfile: path.join(vendor, filename),
        bundle: true, format: 'esm', platform: 'browser', target: 'es2020',
        minify: true, legalComments: 'eof', metafile: true
    });
    const packageDirectories = new Set();
    for (const input of Object.keys(result.metafile.inputs)) {
        const match = input.replaceAll('\\', '/').match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
        if (match) packageDirectories.add(match[1]);
    }
    const packages = [];
    const licenses = [];
    for (const directory of [...packageDirectories].sort()) {
        const info = await packageInfo(directory);
        packages.push({ name: info.name, version: info.version, license: info.license });
        licenses.push(`${info.name}@${info.version}\n${'='.repeat(72)}\n${(await readPackageLicense(path.join(root, directory))).trim()}\n`);
    }
    await writeFile(path.join(vendor, licenseFile), licenses.join('\n'));
    return {
        entry,
        tool: `esbuild@${(await packageInfo('node_modules/esbuild')).version}`,
        format: 'esm',
        sha256: digest(await readFile(path.join(vendor, filename))),
        packages,
        threeInputs: Object.keys(result.metafile.inputs).filter(name => name.startsWith('node_modules/three/')),
        imports: Object.values(result.metafile.outputs).flatMap(file => file.imports)
    };
}

// Stable browser URLs keep package versions in package.json and the generated manifests.
const graph = await bundle('tools/frontend/graph-entry.mjs',
    'graph.mjs', 'FORCE-GRAPH-ESM-LICENSES.txt');
await writeFile(path.join(vendor, 'graph-manifest.json'), JSON.stringify(graph, null, 2) + '\n');

const saxesDirectory = 'saxes';
const saxes = await bundle('tools/frontend/saxes-entry.mjs', `${saxesDirectory}/saxes.mjs`, `${saxesDirectory}/LICENSES.txt`);
await writeFile(path.join(vendor, saxesDirectory, 'SOURCE.json'), JSON.stringify(saxes, null, 2) + '\n');

for (const grammar of ['core', 'markup', 'json']) {
    await copyPackageFile('prismjs', `components/prism-${grammar}.min.js`, `prism-${grammar}.min.js`);
}
await writeFile(path.join(vendor, 'PRISM-LICENSE.txt'),
    await readPackageLicense(path.join(root, 'node_modules/prismjs')));

const oxigraphDirectory = 'oxigraph';
for (const [input, filename] of [['web.js', 'oxigraph.mjs'], ['web_bg.wasm', 'web_bg.wasm']]) {
    await copyPackageFile('oxigraph', input, `${oxigraphDirectory}/${filename}`);
}
await writeFile(path.join(vendor, oxigraphDirectory, 'LICENSES.txt'),
    await readPackageLicense(path.join(root, 'node_modules/oxigraph')));

const bootstrapDirectory = 'bootstrap';
for (const input of ['css/bootstrap.min.css', 'css/bootstrap.min.css.map', 'js/bootstrap.bundle.min.js', 'js/bootstrap.bundle.min.js.map']) {
    await copyPackageFile('bootstrap', `dist/${input}`, `${bootstrapDirectory}/${path.basename(input)}`);
}
await writeFile(path.join(vendor, bootstrapDirectory, 'LICENSE'),
    await readPackageLicense(path.join(root, 'node_modules/bootstrap')));

const files = {};
async function collect(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(filename);
        else files[path.relative(vendor, filename).replaceAll('\\', '/')] = digest(await readFile(filename));
    }
}
await collect(vendor);
const packages = Object.fromEntries(await Promise.all(Object.keys(dependencies).sort().map(async name =>
    [name, (await packageInfo(path.join('node_modules', name))).version])));
await writeFile(path.join(vendor, 'manifest.json'), JSON.stringify({ packages, files }, null, 2) + '\n');
