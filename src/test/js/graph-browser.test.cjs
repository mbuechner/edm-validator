// Optional native browser test (Chrome or GRAPH_BROWSER_EXECUTABLE is required):
// npm ci; npm run build
// node --test src/test/js/graph-browser.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../../..');
const assets = path.join(root, 'target/frontend');
let puppeteerModule;
for (const location of [path.join(root, 'node_modules/puppeteer-core'), 'puppeteer-core']) {
    try { puppeteerModule = require.resolve(location); break; }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
}
const options = {
    timeout: 45000,
    skip: puppeteerModule ? false : 'Run npm ci and npm run build before browser tests.'
};

function fixture() {
    return fs.readFileSync(path.join(assets, 'index.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, script =>
            /src="\.\/graph(?:-fit|-nodes)?\.js"/.test(script) ? script : '')
        .replace(/<link\b[^>]*href="https?:[^>]*>/g, '')
        .replace('</head>', `<style>
            .d-none { display: none !important; }
            body { margin: 0; }
            nav, #mainContent > header, #rdfSource, #pageMessages, #explorerForm { display: none; }
            button { padding: 8px; }
        </style></head>`);
}

function createServer() {
    return http.createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
        if (pathname === '/') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fixture());
            return;
        }
        const filename = path.resolve(assets, '.' + decodeURIComponent(pathname));
        if (!filename.startsWith(assets + path.sep)) { response.writeHead(403).end(); return; }
        try {
            const content = await fs.promises.readFile(filename);
            const type = /\.m?js$/.test(filename) ? 'text/javascript' : filename.endsWith('.css') ? 'text/css'
                : filename.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
            response.writeHead(200, { 'Content-Type': type }).end(content);
        } catch (error) {
            response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
        }
    });
}

async function nextFrames(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function snapshot(page) {
    return page.evaluate(() => ({
        status: document.getElementById('graphMotionStatus').textContent,
        position: window.__graphTestInstance.camera().position.toArray(),
        renderedFrames: window.__graphTestInstance.renderer().info.render.frame
    }));
}

test('native graph autostarts with system and reduced-motion preferences without console debug output', options, async t => {
    const { default: puppeteer } = await import(pathToFileURL(puppeteerModule).href);
    const executablePath = [
        process.env.GRAPH_BROWSER_EXECUTABLE,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ].find(candidate => candidate && fs.existsSync(candidate));
    if (!executablePath) { t.skip('Install Chrome or set GRAPH_BROWSER_EXECUTABLE.'); return; }

    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath,
            headless: true,
            args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        });
        const url = `http://127.0.0.1:${server.address().port}/`;
        for (const preference of ['system', 'reduce']) {
            await t.test(preference, async () => {
                const page = await browser.newPage();
                const debug = [];
                const errors = [];
                page.on('console', message => {
                    if (['log', 'debug', 'info'].includes(message.type())) debug.push(message.text());
                });
                page.on('pageerror', error => errors.push(error.message));
                try {
                    await page.setViewport({ width: 1400, height: 1000 });
                    // The first case deliberately preserves the host's actual OS preference.
                    if (preference === 'reduce') {
                        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
                    }
                    await page.goto(url, { waitUntil: 'networkidle0' });
                    await page.evaluate(async () => {
                        const original = window.RdfGraphNodes;
                        const library = await original.load();
                        // Observe the real instance at its public factory boundary; assets stay byte-for-byte unchanged.
                        window.RdfGraphNodes = { ...original, load: async () => ({
                            ...library,
                            createGraph: (...args) => {
                                const create = library.createGraph(...args);
                                return (...mount) => {
                                    window.__graphTestInstance = create(...mount);
                                    return window.__graphTestInstance;
                                };
                            }
                        }) };
                        const graphNodes = Array.from({ length: 18 }, (_, index) => ({
                            id: 'urn:node:' + index, label: 'Node ' + index,
                            nodeType: index % 3 ? 'IRI' : 'Literal', classes: []
                        }));
                        const graphLinks = graphNodes.slice(1).map((node, index) => ({
                            source: graphNodes[Math.floor(index / 2)].id, target: node.id, predicate: 'related'
                        }));
                        await window.RdfGraphExplorer.render({ graphNodes, graphLinks });
                    });
                    await page.waitForFunction(() => document.getElementById('graphSummary').textContent === '18 Knoten · 17 Verbindungen');
                    assert.equal((await snapshot(page)).status, 'Automatische Drehung aktiv.', 'initial fitting starts rotation immediately');
                    assert.equal(await page.$('#toggleGraphRotationBtn'), null);
                    const before = await snapshot(page);
                    const graphElement = await page.$('#rdfGraph3d');
                    const beforePixels = Buffer.from(await graphElement.screenshot());
                    for (let index = 0; index < 4; index++) {
                        const point = await page.evaluate(nodeIndex => {
                            const graph = window.__graphTestInstance;
                            const node = graph.graphData().nodes[nodeIndex];
                            const projected = graph.graph2ScreenCoords(node.x, node.y, node.z);
                            const rect = document.getElementById('rdfGraph3d').getBoundingClientRect();
                            return { x: rect.left + projected.x, y: rect.top + projected.y };
                        }, index);
                        await page.mouse.move(point.x, point.y, { steps: 6 });
                        await nextFrames(page);
                        assert.equal((await snapshot(page)).status, 'Automatische Drehung aktiv.', 'native pointer motion and node hover keep rotation active');
                    }
                    const after = await snapshot(page);
                    const afterPixels = Buffer.from(await graphElement.screenshot());
                    assert.notDeepEqual(after.position, before.position, 'the actual camera must move');
                    assert.ok(after.renderedFrames > before.renderedFrames, 'WebGL must render new frames');
                    assert.ok(!beforePixels.equals(afterPixels), 'the rendered graph must visibly change');

                    if (preference === 'reduce') {
                        const rect = await graphElement.boundingBox();
                        await page.mouse.move(rect.x + 50, rect.y + 100);
                        await page.mouse.wheel({ deltaY: 120 });
                        await nextFrames(page);
                        const zoomed = await snapshot(page);
                        assert.match(zoomed.status, /drei Sekunden/);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        assert.deepEqual((await snapshot(page)).position, zoomed.position, 'a real zoom gesture starts a quiet period');
                        await page.waitForFunction(() => document.getElementById('graphMotionStatus').textContent === 'Automatische Drehung aktiv.');
                        await nextFrames(page);
                        assert.notDeepEqual((await snapshot(page)).position, zoomed.position, 'rotation resumes without a manual start');
                    }
                    assert.deepEqual(debug, [], 'shipped graph code must not emit console debug logs');
                    assert.deepEqual(errors, [], 'the real graph must not throw browser errors');
                } finally { await page.close(); }
            });
        }
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
});
