// Optional DOM tests: npm install --no-save --prefix target/ui-check jsdom@26.1.0
// Run: node --test src/test/js/converter.test.cjs
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
    test('RDF converter DOM tests', {
        skip: 'Install optional test tools: npm install --no-save --prefix target/ui-check jsdom@26.1.0'
    }, () => {});
}

if (JSDOM) {
    const html = fs.readFileSync(path.join(root, 'src/main/resources/static/converter.html'), 'utf8');
    const script = fs.readFileSync(path.join(root, 'src/main/resources/static/converter.js'), 'utf8');
    const messages = fs.readFileSync(path.join(root, 'src/main/resources/static/messages.js'), 'utf8');
    const sourceKey = 'ddb-rdf-source-v1';
    const sourceScript = fs.readFileSync(path.join(root, 'src/main/resources/static/rdf-source.js'), 'utf8');
    const inputXml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ' +
        'xmlns:schema="http://schema.org/"><rdf:Description rdf:about="https://example.org/org">' +
        '<schema:name xml:lang="de">München &amp; Straße</schema:name></rdf:Description></rdf:RDF>\n';
    const context = JSON.stringify({ '@context': { schema: 'http://schema.org/' } }, null, 2);
    const data = Object.fromEntries([
        ['rdfxml', 'converted.rdf', 'application/rdf+xml', inputXml],
        ['expanded', 'expanded.jsonld', 'application/ld+json', '[{"@id":"https://example.org/org","http://schema.org/name":[{"@value":"München & Straße","@language":"de"}]}]\n'],
        ['compacted', 'compacted.jsonld', 'application/ld+json', '{"@context":{"schema":"http://schema.org/"},"@id":"https://example.org/org","schema:name":{"@value":"<img src=x onerror=alert(1)>","@language":"de"}}\n'],
        ['flattened', 'flattened.jsonld', 'application/ld+json', '[{"@id":"https://example.org/org","http://schema.org/name":[{"@value":"München & Straße","@language":"de"}]}]\n'],
        ['framed', 'framed.jsonld', 'application/ld+json', '{"@context":{"schema":"http://schema.org/"},"@id":"https://example.org/org","schema:name":"München & Straße"}\n']
    ].map(([id, fileName, mediaType, content]) => [id, {
        id, fileName, mediaType, content, sizeBytes: Buffer.byteLength(content, 'utf8'), error: null, empty: false
    }]));
    const jsonChoices = ['compacted', 'expanded'].flatMap(representation =>
        ['standard', 'flattened', 'framed'].map(structure => ({ representation, structure })));
    function resultFor(request) {
        const id = request.rdfXmlOutput ? 'rdfxml' : request.methods[0];
        const result = { ...data[id] };
        if (['flattened', 'framed'].includes(id) && request.representation) {
            result.fileName = id + '-' + request.representation + '.jsonld';
            if (request.representation === 'expanded') result.content = data.expanded.content;
            else if (id === 'flattened') {
                const { '@context': localContext, ...node } = JSON.parse(data.compacted.content);
                result.content = JSON.stringify({ '@context': localContext, '@graph': [node] }) + '\n';
            }
            result.sizeBytes = Buffer.byteLength(result.content, 'utf8');
        }
        return result;
    }
    const payload = (results = [], overrides = {}) => ({
        results, errors: [], autoContext: context, effectiveFrame: null,
        resources: ['https://example.org/part', 'https://example.org/org'], zipBase64: null, ...overrides
    });
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const settled = () => new Promise(resolve => setImmediate(resolve));
    async function until(predicate, description) {
        for (let i = 0; i < 250; i++) {
            if (predicate()) return;
            await pause(10);
        }
        assert.fail('Timed out: ' + description);
    }

    function harness(t, respond, sourceState) {
        const dom = new JSDOM(html, {
            url: 'https://validator.example/app/edm-validator/converter.html',
            runScripts: 'outside-only', pretendToBeVisual: true
        });
        const { window } = dom;
        const calls = [], copies = [], downloads = [], highlights = [], blobs = new Map();
        window.TextEncoder = TextEncoder;
        window.TextDecoder = TextDecoder;
        window.Blob = Blob;
        window.Prism = { highlightElement(code) {
            highlights.push({ code, editor: code.closest('.converter-code-editor')?.querySelector('textarea')?.id });
            const span = window.document.createElement('span');
            span.className = 'token';
            span.textContent = code.textContent;
            code.replaceChildren(span);
        } };
        Object.defineProperty(window.navigator, 'clipboard', {
            value: { writeText: async content => { copies.push(content); } }
        });
        window.URL.createObjectURL = blob => {
            const url = 'blob:test-' + blobs.size;
            blobs.set(url, blob);
            return url;
        };
        window.URL.revokeObjectURL = () => {};
        window.HTMLAnchorElement.prototype.click = function () {
            downloads.push({ fileName: this.download, blob: blobs.get(this.href) });
        };
        window.fetch = (url, options) => {
            const call = { url, ...options };
            calls.push(call);
            let response;
            if (respond) response = respond(call);
            else if (url.endsWith('/inspect')) response = payload();
            else {
                const request = typeof call.body === 'string' ? JSON.parse(call.body) : JSON.parse(call.body.get('options'));
                response = payload([resultFor(request)]);
            }
            return Promise.resolve(response).then(body => ({ ok: true, status: 200, json: async () => body }));
        };
        const localStorage = window.localStorage;
        if (sourceState) localStorage.setItem(sourceKey, JSON.stringify(sourceState));
        window.eval(messages);
        window.eval(fs.readFileSync(path.join(root, 'src/main/resources/static/code-view.js'), 'utf8'));
        window.eval(sourceScript);
        window.eval(script);
        t.after(async () => {
            // Native <details> schedules toggle events outside jsdom's window timers.
            // Let those events finish before disposing the window/document.
            await pause(20);
            window.close();
        });
        const get = id => window.document.getElementById(id);
        const input = (id, value) => {
            get(id).value = value;
            get(id).dispatchEvent(new window.Event('input', { bubbles: true }));
        };
        const check = (id, checked = true) => {
            get(id).checked = checked;
            get(id).dispatchEvent(new window.Event('input', { bubbles: true }));
        };
        const open = (id, value = true) => {
            get(id).open = value;
            get(id).dispatchEvent(new window.Event('toggle'));
        };
        const submit = async () => {
            get('converterForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
            await settled();
        };
        const inspections = () => calls.filter(call => call.url.endsWith('/inspect'));
        const conversions = () => calls.filter(call => !call.url.endsWith('/inspect'));
        return { window, get, input, check, open, submit, inspections, conversions, calls, copies, downloads, highlights, localStorage };
    }
    function action(card, label) {
        const button = [...card.querySelectorAll('button')].find(candidate => candidate.textContent.trim() === label);
        assert.ok(button, 'Missing result action ' + label);
        return button;
    }

    test('simple defaults and mutually exclusive XML/JSON output produce exactly one result', async t => {
        const app = harness(t);
        assert.equal(app.get('converterWorkspace').classList.contains('d-none'), false);
        assert.equal(app.get('validatorWorkspace'), null);
        assert.equal(app.get('showConverter').tagName, 'A');
        assert.equal(app.get('showConverter').getAttribute('aria-current'), 'page');
        assert.equal(app.get('converterRdfXml').type, 'radio');
        assert.equal(app.get('converterJsonLd').type, 'radio');
        assert.equal(app.get('converterRdfXml').checked, false);
        assert.equal(app.get('converterJsonLd').checked, true);
        assert.equal(app.get('converterMethod').value, 'compacted');
        assert.equal(app.get('converterStructure').value, 'standard');
        assert.equal(app.get('converterXmlOptions').classList.contains('d-none'), true);
        assert.equal(app.get('converterXmlRepresentation').value, 'typed');
        assert.equal(app.get('converterXmlStructure').value, 'flat');
        assert.equal(app.get('converterXmlFormatting'), null, 'XML output is always formatted');
        assert.deepEqual([...app.get('converterXmlRepresentation').options].filter(option => option.textContent.includes('(DDB)')).map(option => option.value), ['typed']);
        assert.deepEqual([...app.get('converterXmlStructure').options].filter(option => option.textContent.includes('(DDB)')).map(option => option.value), ['flat']);
        assert.equal(app.get('converterXmlRepresentation').querySelector('option[value="typed"]').textContent.trim(), 'Typisiert (DDB)');
        assert.equal(app.get('converterXmlStructure').querySelector('option[value="flat"]').textContent.trim(), 'Flach (DDB)');
        for (const id of ['converterMethod', 'converterStructure']) {
            assert.equal([...app.get(id).options].some(option => option.textContent.includes('(DDB)')), false,
                'XML recommendations do not imply a recommended JSON-LD transformation');
        }
        assert.deepEqual([...app.get('converterMethod').options].map(option => option.value), ['compacted', 'expanded']);
        assert.equal(app.get('converterFlattenContext'), null);
        assert.equal(app.get('converterEmbedAddress'), null, 'the converter exposes no domain-specific address setting');
        assert.equal(app.get('converterAdvanced').open, false);
        for (const id of ['converterContextOptions', 'converterContextDetails', 'converterContext', 'converterAutoContext',
            'converterContextAuto', 'converterContextCustom', 'converterFramePreview']) assert.equal(app.get(id), null, 'context is always generated automatically');
        assert.equal(app.window.document.querySelector('[name=converterContextMode]'), null);
        assert.equal(app.get('converterEmptyState').classList.contains('d-none'), false);
        assert.equal(app.get('converterDownloadAll'), null);
        await app.submit();
        assert.equal(app.calls.length, 0);
        assert.match(app.get('converterInputError').textContent, /RDF\/XML/);
        app.input('rdfXmlInput', inputXml);
        await app.submit();
        let request = JSON.parse(app.conversions().at(-1).body);
        assert.equal(request.rdfXmlOutput, false);
        assert.equal(request.jsonLdOutput, true);
        assert.deepEqual(request.methods, ['compacted']);
        assert.equal(request.representation, 'compacted');
        assert.equal(request.contextMode, 'generated');
        for (const key of ['context', 'frameMode', 'frame', 'rootIri', 'embed']) {
            assert.equal(Object.hasOwn(request, key), false, 'normal JSON omits unused ' + key);
        }
        assert.equal(Object.hasOwn(request, 'embedAddress'), false);
        assert.equal(Object.hasOwn(request, 'flattenWithContext'), false);
        assert.equal(Object.hasOwn(request, 'xmlStructure'), false);
        assert.equal(Object.hasOwn(request, 'xmlRepresentation'), false);
        assert.equal(Object.hasOwn(request, 'xmlFormatting'), false);
        assert.equal(app.get('converterResults').querySelectorAll('article').length, 1);
        assert.equal(app.get('converterEmptyState').classList.contains('d-none'), true);
        app.check('converterRdfXml');
        assert.equal(app.get('converterJsonLd').checked, false);
        assert.match(app.get('converterOutputSummary').textContent, /RDF\/XML/);
        assert.equal(app.get('converterJsonOptions').classList.contains('d-none'), true);
        assert.equal(app.get('converterMethod').disabled, true);
        assert.equal(app.get('converterStructure').disabled, true);
        assert.equal(app.get('converterFrameOptions').classList.contains('d-none'), true);
        assert.equal(app.get('converterXmlOptions').classList.contains('d-none'), false);
        assert.equal(app.get('converterResults').children.length, 0);
        await app.submit();
        request = JSON.parse(app.conversions().at(-1).body);
        assert.equal(request.rdfXmlOutput, true);
        assert.equal(request.jsonLdOutput, false);
        assert.deepEqual(Object.keys(request).sort(), ['baseIri', 'documentIri', 'jsonLdOutput', 'rdfXml', 'rdfXmlOutput', 'xmlRepresentation', 'xmlStructure']);
        assert.equal(request.xmlRepresentation, 'typed');
        assert.equal(request.xmlStructure, 'flat');
        assert.equal(Object.hasOwn(request, 'xmlFormatting'), false);
        assert.equal(Object.hasOwn(request, 'embedAddress'), false);
        assert.equal(Object.hasOwn(request, 'flattenWithContext'), false);
        app.check('converterJsonLd');
        for (const { representation, structure } of jsonChoices) {
            app.input('converterMethod', representation);
            app.input('converterStructure', structure);
            if (structure === 'framed') app.input('converterRoot', 'https://example.org/org');
            assert.equal(app.get('converterFrameOptions').classList.contains('d-none'), structure !== 'framed');
            await app.submit();
            request = JSON.parse(app.conversions().at(-1).body);
            assert.deepEqual(request.methods, [structure === 'standard' ? representation : structure]);
            assert.equal(request.representation, representation);
            assert.equal(request.rdfXmlOutput, false);
            assert.equal(request.contextMode, 'generated', 'all JSON-LD variants use the generated context');
            assert.equal(Object.hasOwn(request, 'context'), false, 'automatic contexts do not send an unused custom draft');
            if (structure === 'framed') {
                assert.equal(request.frameMode, 'form');
                assert.equal(request.rootIri, 'https://example.org/org');
                assert.equal(request.embed, '@once');
                assert.equal(Object.hasOwn(request, 'frame'), false, 'form mode omits the inactive frame draft');
            } else {
                for (const key of ['frameMode', 'frame', 'rootIri', 'embed']) {
                    assert.equal(Object.hasOwn(request, key), false, 'unframed JSON omits ' + key);
                }
            }
            assert.equal(Object.hasOwn(request, 'embedAddress'), false);
            assert.equal(Object.hasOwn(request, 'flattenWithContext'), false);
            assert.equal(Object.hasOwn(request, 'xmlStructure'), false);
            assert.equal(Object.hasOwn(request, 'xmlRepresentation'), false);
            assert.equal(Object.hasOwn(request, 'xmlFormatting'), false);
            assert.equal(app.get('converterResults').querySelectorAll('article').length, 1);
        }
    });

    test('XML representation and structure combine independently and stay separate from JSON settings', async t => {
        let xmlIssue;
        const app = harness(t, call => {
            if (call.url.endsWith('/inspect')) return payload();
            const request = JSON.parse(call.body);
            return xmlIssue ? payload([], {errors: [xmlIssue]}) : payload([resultFor(request)]);
        });
        app.input('rdfXmlInput', inputXml);
        app.check('converterRdfXml');
        app.open('converterAdvanced');
        for (const representation of ['typed', 'explicit']) {
            for (const structure of ['flat', 'nested']) {
                app.input('converterXmlRepresentation', representation);
                app.input('converterXmlStructure', structure);
                assert.equal(app.get('converterResults').children.length, 0, 'XML setting edits invalidate the previous output');
                await app.submit();
                const request = JSON.parse(app.conversions().at(-1).body);
                assert.equal(request.xmlRepresentation, representation);
                assert.equal(request.xmlStructure, structure);
                assert.equal(Object.hasOwn(request, 'xmlFormatting'), false);
                assert.equal(request.rdfXmlOutput, true);
                assert.equal(request.jsonLdOutput, false);
                assert.deepEqual(Object.keys(request).sort(), ['baseIri', 'documentIri', 'jsonLdOutput', 'rdfXml', 'rdfXmlOutput', 'xmlRepresentation', 'xmlStructure']);
                assert.equal(app.get('converterResults').querySelectorAll('article').length, 1);
                const selectedLabels = ['converterXmlRepresentation', 'converterXmlStructure']
                    .map(id => app.get(id).selectedOptions[0].textContent.trim());
                const summary = selectedLabels.join(' · ');
                assert.equal(app.get('converterOutputSummary').textContent, 'RDF/XML · ' + summary,
                    'each independent selection and its recommendation marker appear in the summary');
                assert.equal(app.get('converterResults').querySelector('h3').textContent, 'RDF/XML · ' + summary);
            }
        }
        app.check('converterJsonLd');
        assert.equal(app.get('converterXmlOptions').classList.contains('d-none'), true);
        app.input('converterMethod', 'expanded');
        app.input('converterStructure', 'flattened');
        await app.submit();
        assert.doesNotMatch(app.get('converterOutputSummary').textContent, /DDB/);
        let request = JSON.parse(app.conversions().at(-1).body);
        assert.deepEqual(request.methods, ['flattened']);
        assert.equal(request.representation, 'expanded');
        assert.equal(Object.hasOwn(request, 'xmlStructure'), false);
        assert.equal(Object.hasOwn(request, 'xmlRepresentation'), false);
        assert.equal(Object.hasOwn(request, 'xmlFormatting'), false);
        app.check('converterRdfXml');
        assert.equal(app.get('converterXmlRepresentation').value, 'explicit');
        assert.equal(app.get('converterXmlStructure').value, 'nested');
        await app.submit();
        request = JSON.parse(app.conversions().at(-1).body);
        assert.equal(request.xmlRepresentation, 'explicit');
        assert.equal(request.xmlStructure, 'nested');
        assert.equal(Object.hasOwn(request, 'xmlFormatting'), false);
        await pause(650);
        assert.equal(app.inspections().length, 0, 'XML option edits never trigger JSON metadata loading');
        for (const [field, id] of [['xmlRepresentation', 'converterXmlRepresentation'], ['xmlStructure', 'converterXmlStructure']]) {
            xmlIssue = {field, message: 'Bitte eine gültige XML-Einstellung auswählen: ' + field};
            app.open('converterAdvanced', false);
            await app.submit();
            assert.equal(app.get('converterAdvanced').open, true);
            assert.equal(app.window.document.activeElement, app.get(id));
            assert.ok(app.get('converterOutputError').textContent.includes(field));
            assert.ok(app.get('converterErrors').textContent.includes(field));
        }
    });

    test('preview, clipboard and UTF-8 download preserve each single generated document', async t => {
        const app = harness(t);
        app.input('rdfXmlInput', inputXml);
        for (const choice of [{ xml: true }, ...jsonChoices]) {
            app.check(choice.xml ? 'converterRdfXml' : 'converterJsonLd');
            if (!choice.xml) {
                app.input('converterMethod', choice.representation);
                app.input('converterStructure', choice.structure);
            }
            if (choice.structure === 'framed') app.input('converterRoot', 'https://example.org/org');
            await app.submit();
            const request = JSON.parse(app.conversions().at(-1).body);
            const result = resultFor(request);
            const cards = app.get('converterResults').querySelectorAll('article');
            assert.equal(cards.length, 1);
            const code = cards[0].querySelector('pre code');
            assert.equal(code.textContent, result.content);
            assert.equal(cards[0].querySelector('pre').textContent, result.content, 'decorative numbers never enter output text');
            assert.equal(cards[0].querySelector('.code-view-gutter').getAttribute('aria-hidden'), 'true');
            assert.equal(code.className, result.id === 'rdfxml' ? 'language-markup' : 'language-json');
            action(cards[0], 'Kopieren').click();
            await settled();
            assert.equal(app.copies.at(-1), result.content);
            action(cards[0], 'Herunterladen').click();
            const saved = app.downloads.at(-1);
            assert.equal(saved.fileName, result.fileName);
            assert.equal(saved.blob.type, result.mediaType + ';charset=utf-8');
            assert.equal(saved.blob.size, result.sizeBytes);
            assert.equal(await saved.blob.text(), result.content);
            assert.equal(app.get('converterResults').querySelector('img'), null, 'document contents remain text');
        }
    });

    test('metadata is loaded on demand and cached across display-setting changes', async t => {
        const app = harness(t);
        app.input('rdfXmlInput', inputXml);
        await pause(850);
        assert.equal(app.inspections().length, 0, 'default typing does not parse RDF in the background');
        app.check('converterRdfXml');
        app.open('converterAdvanced');
        await pause(850);
        assert.equal(app.inspections().length, 0, 'XML needs no JSON-LD metadata request');
        app.check('converterJsonLd');
        await pause(650);
        assert.equal(app.inspections().length, 0, 'normal JSON output needs no metadata request');
        app.input('converterStructure', 'framed');
        await until(() => app.inspections().length === 1, 'on-demand framing metadata request');
        await settled();
        const request = JSON.parse(app.inspections()[0].body);
        assert.equal(request.rdfXmlOutput, false);
        assert.equal(request.jsonLdOutput, false);
        assert.deepEqual(Object.keys(request).sort(), ['baseIri', 'documentIri', 'jsonLdOutput', 'rdfXml', 'rdfXmlOutput'],
            'metadata requests carry only model input and disabled output flags');
        assert.equal(Object.hasOwn(request, 'flattenWithContext'), false);
        assert.equal(app.get('converterResources').options.length, 2);
        app.input('converterStructure', 'framed');
        app.input('converterMethod', 'expanded');
        app.input('converterRoot', 'https://example.org/org');
        app.check('converterEmbedNever');
        app.open('converterAdvanced', false);
        app.open('converterAdvanced');
        app.check('converterRdfXml');
        app.check('converterJsonLd');
        await pause(850);
        assert.equal(app.inspections().length, 1, 'settings reuse metadata for the same graph');
        app.input('converterBase', 'https://example.org/source/');
        await until(() => app.inspections().length === 2, 'refresh for changed base');
        await settled();
        app.input('rdfXmlInput', inputXml + '\n');
        await until(() => app.inspections().length === 3, 'refresh for changed source');
        await settled();
    });

    test('conversion supplies metadata without a second background parse', async t => {
        const app = harness(t);
        app.input('rdfXmlInput', inputXml);
        await app.submit();
        app.open('converterAdvanced');
        await pause(850);
        assert.equal(app.inspections().length, 0);
        app.input('converterStructure', 'framed');
        app.input('converterRoot', 'https://example.org/org');
        app.check('converterFrameCustom');
        assert.deepEqual(Object.keys(JSON.parse(app.get('converterFrame').value)).sort(), ['@embed', '@id'],
            'the client draft has no context configuration; the server generates it');
        assert.equal(app.get('converterResources').options.length, 2);
    });

    test('opening advanced settings during conversion does not start a redundant parse or cancel conversion', async t => {
        let release;
        const app = harness(t, call => call.url.endsWith('/inspect') ? payload() :
            new Promise(resolve => { release = resolve; }));
        app.input('rdfXmlInput', inputXml);
        await app.submit();
        const pending = app.conversions()[0];
        app.open('converterAdvanced');
        await pause(650);
        assert.equal(app.inspections().length, 0, 'the in-flight conversion will provide the same metadata');
        app.open('converterAdvanced', false);
        assert.equal(pending.signal.aborted, false, 'closing optional settings does not cancel conversion');
        release(payload([data.compacted]));
        await settled();
        assert.equal(app.get('converterResults').querySelectorAll('article').length, 1);
    });

    test('the optional frame editor batches highlighting and keeps large drafts readable', async t => {
        const app = harness(t);
        app.open('converterAdvanced');
        app.input('converterStructure', 'framed');
        app.check('converterFrameCustom');
        await pause(180);
        app.highlights.length = 0;
        const frame = '{"@id":"https://example.org/org","@embed":"@once"}';
        for (let i = 1; i <= 3; i++) app.input('converterFrame', frame + ' '.repeat(i));
        await pause(180);
        assert.equal(app.highlights.filter(call => call.editor === 'converterFrame').length, 1);
        app.highlights.length = 0;
        const large = frame + ' '.repeat(500_000);
        app.input('converterFrame', large);
        await pause(180);
        assert.equal(app.highlights.filter(call => call.editor === 'converterFrame').length, 0);
        assert.equal(app.get('converterFrame').value, large);
        assert.equal(app.get('converterFrame').parentElement.classList.contains('converter-editor-plain'), true);
        app.input('converterFrame', frame);
        await pause(180);
        const highlights = app.highlights.filter(call => call.editor === 'converterFrame').length;
        app.check('converterFrameForm');
        app.check('converterFrameCustom');
        await pause(180);
        assert.equal(app.highlights.filter(call => call.editor === 'converterFrame').length, highlights,
            'reopening an unchanged frame reuses its highlighted content');
    });

    test('edits clear stale downloads and late conversion responses cannot restore them', async t => {
        let release, deferred = false;
        const app = harness(t, call => {
            if (call.url.endsWith('/inspect')) return payload();
            return deferred ? new Promise(resolve => { release = resolve; }) : payload([data.compacted]);
        });
        app.input('rdfXmlInput', inputXml);
        await app.submit();
        app.input('converterStructure', 'flattened');
        assert.equal(app.get('converterResults').children.length, 0);
        assert.equal(app.get('converterEmptyState').classList.contains('d-none'), false);
        assert.match(app.get('converterStatus').textContent, /erneut konvertieren/);
        deferred = true;
        await app.submit();
        assert.equal(app.get('converterSubmit').disabled, true);
        const pending = app.conversions().at(-1);
        app.input('rdfXmlInput', inputXml + '\n');
        assert.equal(pending.signal.aborted, true);
        assert.equal(app.get('converterSubmit').disabled, false);
        release(payload([data.flattened], { autoContext: '{"@context":{"outdated":"https://outdated/"}}', resources: ['https://outdated/'] }));
        await settled();
        assert.equal(app.get('converterResults').children.length, 0);
        app.input('converterStructure', 'framed');
        app.input('converterRoot', 'https://example.org/org');
        app.open('converterAdvanced');
        app.check('converterFrameCustom');
        assert.doesNotMatch(app.get('converterResources').textContent, /outdated/);
        assert.equal(app.get('converterResources').options.length, 0, 'late metadata cannot repopulate a changed document');
    });

    test('unavailable or rejected Clipboard API selects the exact source for manual copying', async t => {
        for (const scenario of ['unavailable', 'rejected']) {
            const app = harness(t);
            app.window.navigator.clipboard.writeText = scenario === 'unavailable' ? undefined : async () => { throw new Error('Denied'); };
            let deprecatedCalls = 0;
            app.window.document.execCommand = () => { deprecatedCalls++; throw new Error('Deprecated copying'); };
            app.input('rdfXmlInput', inputXml);
            await app.submit();
            const card = app.get('converterResults').querySelector('article');
            const source = card.querySelector('pre');
            action(card, 'Kopieren').click();
            await settled();
            assert.equal(app.window.document.activeElement, source, scenario);
            assert.equal(app.window.getSelection().toString(), data.compacted.content, scenario);
            assert.match(app.get('converterStatus').textContent, /markiert.*Strg\+C/, scenario);
            assert.equal(deprecatedCalls, 0, scenario);
        }
    });

    test('generic form framing and custom per-property rules remain separate and survive display-mode changes', async t => {
        const app = harness(t);
        app.input('rdfXmlInput', inputXml);
        await app.submit();
        app.open('converterAdvanced');
        app.input('converterStructure', 'framed');
        app.input('converterRoot', 'https://example.org/org');
        app.check('converterEmbedNever');
        app.check('converterFrameCustom');
        const generated = JSON.parse(app.get('converterFrame').value);
        assert.equal(generated['@embed'], '@never');
        assert.equal(generated['@id'], 'https://example.org/org');
        assert.deepEqual(Object.keys(generated).sort(), ['@embed', '@id']);
        assert.equal(app.get('converterFrameFields').disabled, true);
        const manual = '{"@context":{"ex":"https://example.org/vocabulary/"},"@id":"https://example.org/manual","@embed":"@never","https://example.org/vocabulary/hasPart":{"@embed":"@always"}}';
        app.input('converterFrame', manual);
        app.check('converterFrameForm');
        app.input('converterRoot', 'https://example.org/other');
        await app.submit();
        const formRequest = JSON.parse(app.conversions().at(-1).body);
        assert.equal(formRequest.frameMode, 'form');
        assert.equal(formRequest.rootIri, 'https://example.org/other');
        assert.equal(Object.hasOwn(formRequest, 'frame'), false, 'custom property rules do not leak into form framing');
        app.check('converterFrameCustom');
        assert.equal(app.get('converterFrame').value, manual);
        app.input('converterMethod', 'expanded');
        await pause(180);
        await app.submit();
        const request = JSON.parse(app.conversions().at(-1).body);
        assert.equal(request.frameMode, 'custom');
        assert.equal(request.contextMode, 'generated', 'the server replaces any custom root context with generated namespaces');
        assert.equal(request.frame, manual);
        assert.equal(Object.hasOwn(request, 'rootIri'), false, 'the disabled form root does not override a custom frame');
        assert.equal(Object.hasOwn(request, 'embed'), false, 'the disabled form embed setting is not sent');
        assert.deepEqual(request.methods, ['framed']);
        assert.equal(request.representation, 'expanded');
        assert.equal(Object.hasOwn(request, 'embedAddress'), false);
        assert.equal(Object.hasOwn(request, 'flattenWithContext'), false);
    });

    test('the shared document is immediately usable and resetting options preserves it for other tools', async t => {
        const originalIri = 'https://api.example/record/source.rdf';
        const source = {rdfXml: inputXml, documentIri: originalIri, ddbUri: 'https://www.deutsche-digitale-bibliothek.de/item/EXAMPLE'};
        const app = harness(t, null, source);
        assert.equal(app.get('converterInput'), null, 'the converter has no separate source editor');
        assert.equal(app.get('converterFile'), null, 'file import belongs to the shared source');
        assert.equal(app.get('rdfXmlInput').closest('#converterForm'), null, 'source is above the tool options');
        assert.equal(app.get('rdfXmlInput').value, inputXml);
        await app.submit();
        const request = JSON.parse(app.conversions().at(-1).body);
        assert.equal(request.rdfXml, inputXml);
        assert.equal(request.documentIri, originalIri);
        assert.equal(request.baseIri, null);
        app.input('converterMethod', 'expanded');
        app.input('converterBase', 'https://temporary.example/');
        app.open('converterAdvanced');
        app.get('converterReset').click();
        assert.equal(app.get('rdfXmlInput').value, inputXml, 'resetting options never clears the document shared with other tools');
        assert.equal(app.window.RdfSource.get().documentIri, originalIri);
        assert.equal(JSON.parse(app.localStorage.getItem(sourceKey)).rdfXml, inputXml);
        assert.equal(app.get('converterJsonLd').checked, true);
        assert.equal(app.get('converterMethod').value, 'compacted');
        assert.equal(app.get('converterStructure').value, 'standard');
        assert.equal(app.get('converterXmlRepresentation').value, 'typed');
        assert.equal(app.get('converterXmlStructure').value, 'flat');
        assert.equal(app.get('converterBase').value, '');
        assert.equal(app.get('converterAdvanced').open, false);
        assert.equal(app.get('converterResults').children.length, 0);
    });

    test('a new shared source invalidates pending work while editing only the DDB URI leaves it usable', async t => {
        let release;
        const app = harness(t, call => call.url.endsWith('/inspect') ? payload() :
            new Promise(resolve => { release = resolve; }));
        app.window.RdfSource.set({rdfXml: inputXml, documentIri: 'https://example.org/original.rdf'});
        app.input('converterBase', 'https://temporary.example/');
        await app.submit();
        const pending = app.conversions().at(-1);
        app.input('ddbUri', 'https://www.deutsche-digitale-bibliothek.de/item/OTHER');
        assert.equal(pending.signal.aborted, false, 'a candidate URI does not change the current document');
        app.window.RdfSource.set({rdfXml: '<new/>', documentIri: 'https://example.org/new.rdf'});
        assert.equal(pending.signal.aborted, true);
        assert.equal(app.get('converterBase').value, '', 'a different source does not inherit an unrelated conversion base');
        assert.equal(app.get('converterSubmit').disabled, false);
        release(payload([data.compacted]));
        await settled();
        assert.equal(app.get('converterResults').children.length, 0);
        assert.equal(app.get('rdfXmlInput').value, '<new/>');
        assert.equal(app.window.RdfSource.get().documentIri, 'https://example.org/new.rdf');
    });

    test('field errors reveal advanced controls and an empty framed result is explicit', async t => {
        let mode = 'base';
        const app = harness(t, call => {
            if (call.url.endsWith('/inspect')) return payload();
            if (mode === 'base') return payload([], { errors: [{ field: 'baseIri', message: 'Relative IRIs benötigen eine Basis-IRI.' }] });
            if (mode === 'context') return payload([{ ...data.compacted, content: null, error: 'Ungültiger Kontext' }],
                { errors: [{ field: 'context', message: 'Ungültiger Kontext: @context fehlt.' }] });
            return payload([{ ...data.framed, content: '{"@context":{},"@graph":[]}', empty: true }]);
        });
        app.input('rdfXmlInput', inputXml);
        await app.submit();
        assert.equal(app.get('converterAdvanced').open, true);
        assert.match(app.get('converterBaseError').textContent, /Basis-IRI/);
        assert.match(app.get('converterErrors').textContent, /Basis-IRI/, 'the top-level alert also explains the field error');
        assert.equal(app.get('converterErrors').closest('#pageMessages'), app.get('pageMessages'));
        mode = 'context';
        app.open('converterAdvanced', false);
        await app.submit();
        assert.equal(app.get('converterAdvanced').open, false, 'a generated context has no hidden editor to reveal');
        assert.match(app.get('converterOutputError').textContent, /@context fehlt/);
        assert.match(app.get('converterErrors').textContent, /@context fehlt/);
        assert.equal(app.window.document.activeElement, app.get('converterJsonLd'));
        assert.equal(app.get('converterResults').querySelectorAll('button').length, 0);
        mode = 'empty';
        app.input('converterStructure', 'framed');
        app.input('converterRoot', 'https://example.org/org');
        await app.submit();
        const card = app.get('converterResults').querySelector('article');
        assert.match(app.get('converterStatus').textContent, /leeres Trefferergebnis/);
        assert.ok(app.get('converterStatus').querySelector('.alert-warning'));
        assert.doesNotMatch(card.textContent, /leeres Trefferergebnis/, 'the global warning is not duplicated below');
        assert.equal(card.querySelectorAll('button').length, 2);
        assert.equal(app.get('converterErrors').classList.contains('d-none'), true, 'a later success clears old errors');
    });

    test('a rich multiline writer failure preserves readable safe diagnostics centrally and allows a later retry', async t => {
        const lines = [
            'RDF/XML konnte nicht geschrieben werden: Not an RDF IRI: http://',
            'Abgeleiteter Namespace: http://',
            'Betroffenes Prädikat: http://example.testlabel',
            'Präfixdeklaration: xmlns:ex="http://example.test"',
            'Betroffenes Subjekt: https://example.org/resource',
            'Hinweis: <img src=x onerror=alert(1)> & "Details"'
        ];
        const cause = lines.join('\n');
        let failed = true;
        const app = harness(t, call => {
            if (call.url.endsWith('/inspect')) return payload();
            return payload([failed ? {...data.rdfxml, content: null, error: cause} : data.rdfxml]);
        });
        app.input('rdfXmlInput', inputXml);
        app.check('converterRdfXml');
        await app.submit();
        const errors = app.get('converterErrors');
        assert.equal(errors.closest('#pageMessages'), app.get('pageMessages'));
        assert.equal(errors.classList.contains('d-none'), false);
        assert.deepEqual([...errors.querySelectorAll('.alert p')].map(paragraph => paragraph.textContent), lines,
            'each diagnostic line has its own readable paragraph without losing the original text');
        assert.ok([...errors.querySelectorAll('.alert p')].every(paragraph => paragraph.classList.contains('text-break')));
        assert.ok(errors.querySelector('.alert-danger .btn-close'));
        assert.equal(errors.querySelector('img'), null, 'diagnostics remain text instead of executable markup');
        assert.equal(app.get('converterStatus').classList.contains('d-none'), true, 'no duplicate generic warning');
        assert.equal(app.get('converterResults').children.length, 0);
        assert.equal(app.get('converterResults').querySelectorAll('button').length, 0, 'failed output has no download actions');
        assert.equal(app.get('converterEmptyState').classList.contains('d-none'), false);
        errors.querySelector('.btn-close').click();
        assert.equal(errors.classList.contains('d-none'), true, 'the diagnostic alert can be dismissed');
        failed = false;
        await app.submit();
        assert.equal(errors.classList.contains('d-none'), true);
        assert.ok(app.get('converterStatus').querySelector('.alert-success'));
        assert.equal(app.get('converterResults').querySelectorAll('button').length, 2);
    });
}
