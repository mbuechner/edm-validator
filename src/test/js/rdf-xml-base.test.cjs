const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const helper = import(pathToFileURL(path.resolve(__dirname, '../../main/resources/static/rdf-xml-base.mjs')).href);

test('relative base resolution follows RFC 3986 normal and abnormal reference vectors', async () => {
    const {resolveXmlBase} = await helper;
    const base = 'https://a/b/c/d;p?q';
    for (const [reference, expected] of [
        ['g:h', 'g:h'], ['g', 'https://a/b/c/g'], ['./g', 'https://a/b/c/g'], ['g/', 'https://a/b/c/g/'],
        ['/g', 'https://a/g'], ['//g', 'https://g'], ['?y', 'https://a/b/c/d;p?y'], ['g?y', 'https://a/b/c/g?y'],
        ['#s', 'https://a/b/c/d;p?q#s'], ['g#s', 'https://a/b/c/g#s'], ['g?y#s', 'https://a/b/c/g?y#s'],
        [';x', 'https://a/b/c/;x'], ['g;x', 'https://a/b/c/g;x'], ['g;x?y#s', 'https://a/b/c/g;x?y#s'],
        ['', 'https://a/b/c/d;p?q'], ['.', 'https://a/b/c/'], ['./', 'https://a/b/c/'],
        ['..', 'https://a/b/'], ['../', 'https://a/b/'], ['../g', 'https://a/b/g'],
        ['../..', 'https://a/'], ['../../', 'https://a/'], ['../../g', 'https://a/g'],
        ['../../../g', 'https://a/g'], ['../../../../g', 'https://a/g'], ['/./g', 'https://a/g'], ['/../g', 'https://a/g'],
        ['g.', 'https://a/b/c/g.'], ['.g', 'https://a/b/c/.g'], ['g..', 'https://a/b/c/g..'], ['..g', 'https://a/b/c/..g'],
        ['./../g', 'https://a/b/g'], ['./g/.', 'https://a/b/c/g/'], ['g/./h', 'https://a/b/c/g/h'],
        ['g/../h', 'https://a/b/c/h'], ['g;x=1/./y', 'https://a/b/c/g;x=1/y'], ['g;x=1/../y', 'https://a/b/c/y'],
        ['g?y/./x', 'https://a/b/c/g?y/./x'], ['g?y/../x', 'https://a/b/c/g?y/../x'],
        ['g#s/./x', 'https://a/b/c/g#s/./x'], ['g#s/../x', 'https://a/b/c/g#s/../x'], ['http:g', 'http:g']
    ]) assert.equal(resolveXmlBase(reference, base), expected, reference);
});

test('IRI resolution preserves Unicode, percent escapes, host spelling and explicit ports', async () => {
    const {resolveXmlBase} = await helper;
    const base = 'https://EXÄMPLE.org:443/München/%2e/%2F/file?q=Alt#frag';
    assert.equal(resolveXmlBase('../Straße/😀?x=%2f#Ü', base),
        'https://EXÄMPLE.org:443/München/%2e/Straße/😀?x=%2f#Ü');
    assert.equal(resolveXmlBase('/%2E/./%2f', base), 'https://EXÄMPLE.org:443/%2E/%2f');
    assert.equal(resolveXmlBase('?new', base), 'https://EXÄMPLE.org:443/München/%2e/%2F/file?new');
    assert.equal(resolveXmlBase('https://EXÄMPLE.org:443/a/../b', base), 'https://EXÄMPLE.org:443/a/../b',
        'already absolute attributes are left to the native parser unchanged');
});

test('SAX rewrites attribute value spans only, preserving comments, PI, CDATA, CRLF and quotes', async () => {
    const {resolveRdfXmlBases} = await helper;
    const input = `<?xml version="1.0"?>\r\n<?probe value="xml:base='../fake'"?>\r\n` +
        `<!-- xml:base="../fake" -->\r\n` +
        `<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:e="urn:e:" xml:base = '../München/&#x1F600;?q=&apos;Sammlung&apos;&amp;x=1'>\r\n` +
        ` <r:Description xml:base="nested/" r:about="item" e:unchanged="a'&quot;b">\r\n` +
        `  <e:raw><![CDATA[xml:base="../fake" & <keep/>]]></e:raw>\r\n` +
        ` </r:Description>\r\n</r:RDF>`;
    const output = resolveRdfXmlBases(input, 'https://EXAMPLE.org:443/a/meta/source.rdf');
    const expected = input
        .replace("'../München/&#x1F600;?q=&apos;Sammlung&apos;&amp;x=1'", "'https://EXAMPLE.org:443/a/München/😀?q=&apos;Sammlung&apos;&amp;x=1'")
        .replace('xml:base="nested/"', 'xml:base="https://EXAMPLE.org:443/a/München/nested/"');
    assert.equal(output, expected);
});

test('XML literal descendants stay byte-for-byte opaque and sibling base scopes are restored', async () => {
    const {resolveRdfXmlBases} = await helper;
    const literal = `<span xmlns="urn:markup" xml:base='../DO-NOT-REWRITE/' title="&quot; &amp;">München\r\n<![CDATA[<raw/>]]></span>`;
    const input = `<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:e="urn:e:" xml:base="../records/">` +
        `<r:Description r:about="item"><e:xml r:parseType="Literal" xml:base='inside/'>${literal}</e:xml>` +
        `<e:other xml:base="sibling/" r:resource="view"/></r:Description></r:RDF>`;
    const output = resolveRdfXmlBases(input, 'https://example.org/source/metadata/file.rdf');
    assert.ok(output.includes(literal), 'no serializer or base resolver touches XML literal markup');
    assert.ok(output.includes("xml:base='https://example.org/source/records/inside/'"));
    assert.ok(output.includes('xml:base="https://example.org/source/records/sibling/"'));
});

test('absolute XML bases need no rewrite and malformed or unresolvable inputs stay errors', async () => {
    const {resolveRdfXmlBases, resolveXmlBase} = await helper;
    const absolute = `<root xml:base="https://EXAMPLE.org:443/München/a/../b"/>`;
    assert.equal(resolveRdfXmlBases(absolute, 'https://example.org/'), absolute);
    assert.throws(() => resolveRdfXmlBases('<root xml:base="../a/"><broken></root>', 'https://example.org/'));
    assert.throws(() => resolveRdfXmlBases('<root xml:base="../a/"/>'), /absolute/);
    assert.throws(() => resolveXmlBase('1invalid:scheme', 'https://example.org/'), /Ungültige/);
});
