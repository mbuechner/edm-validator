import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const fallbacks = JSON.parse(await readFile(new URL('./licenses/manifest.json', import.meta.url), 'utf8'));
const commonNames = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.txt'];
const normalize = text => text.replace(/\r\n?/g, '\n');

/** Prefer the installed package's own license; a matching SPDX fallback never depends on its version. */
export async function readPackageLicense(packageDirectory, filenames) {
    for (const name of filenames ?? commonNames) {
        try { return normalize(await readFile(path.join(packageDirectory, name), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!filenames) {
        const names = (await readdir(packageDirectory, { withFileTypes: true }))
            .filter(entry => entry.isFile() && /^licen[cs]e(?:$|[._-])/i.test(entry.name))
            .map(entry => entry.name).sort();
        if (names.length) return (await Promise.all(names.map(name =>
            readFile(path.join(packageDirectory, name), 'utf8')))).map(normalize).join('\n');
    }
    const info = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
    const fallback = fallbacks[info.name];
    if (fallback && fallback.license === info.license) {
        for (const name of filenames ?? ['LICENSE']) {
            const files = fallback.files[name];
            if (files) return (await Promise.all(files.map(filename => readFile(
                new URL(`./licenses/${fallback.directory}/${filename}`, import.meta.url), 'utf8'))))
                .map(normalize).join('\n');
        }
    }
    throw new Error(`No matching license for ${info.name}@${info.version} (${info.license})`);
}
