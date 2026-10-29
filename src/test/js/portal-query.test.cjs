const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../../..');
const staticRoot = path.join(root, 'src/main/resources/static');
const preset = fs.readFileSync(path.join(staticRoot, 'queries/portal-select.rq'), 'utf8');
// Deliberately controlled test data, not the user's source record or a normalized runtime input.
const rdfXml = fs.readFileSync(path.join(root, 'src/test/resources/query/portal-controlled.rdf.xml'), 'utf8');
// Supplied museum record: only occurredAt and the DDB aggregation fragment were corrected.
// The user's original file under tmp/ remains untouched.
const museumXml = fs.readFileSync(path.join(root, 'src/test/resources/query/224IOLKFSF3WLN3FUEHIBGIVX3PRYU6I.rdf.xml'), 'utf8');
const item = 'https://www.deutsche-digitale-bibliothek.de/item/224IOLKFSF3WLN3FUEHIBGIVX3PRYU6I';
const second = 'https://example.org/query/second-object';
const fields = [
    'id', 'portal_url', 'titel', 'beschreibung', 'objekttyp', 'beteiligte', 'ereignisse', 'datierung',
    'abmessungen', 'identifikatoren', 'ort', 'aufbewahrung', 'datenlieferant', 'sparte',
    'vorschau_url', 'original_url', 'digitalisat_url', 'digitalisat_format', 'digitalisat_rechte_url', 'metadaten_rechte_url'
];
let wasmModule;

async function harness(t) {
    wasmModule ||= import(pathToFileURL(path.join(staticRoot, 'vendor/oxigraph-0.5.13/oxigraph.mjs')).href).then(module => {
        module.initSync({module: fs.readFileSync(path.join(staticRoot, 'vendor/oxigraph-0.5.13/web_bg.wasm'))});
        return module;
    });
    const [oxigraph, {createSparqlEngine}] = await Promise.all([
        wasmModule, import(pathToFileURL(path.join(staticRoot, 'sparql-engine.mjs')).href)
    ]);
    const counts = {initialize: 0, load: 0, query: 0};
    // Instrument the real WASM-backed Store; parser, query evaluator and results stay unmodified.
    class MeasuredStore extends oxigraph.Store {
        load(...args) { counts.load++; return super.load(...args); }
        query(...args) { counts.query++; return super.query(...args); }
    }
    const engine = createSparqlEngine({initialize: async () => {
        counts.initialize++;
        return {...oxigraph, Store: MeasuredStore};
    }});
    t.after(() => engine.dispose());
    return {engine, counts};
}

function valuesSet(value) {
    return new Set(value === '' ? [] : value.split('; '));
}

function stringsOnly(row) {
    assert.deepEqual(Object.keys(row), fields);
    fields.forEach(field => assert.equal(typeof row[field], 'string', field));
}

function assertCompleteObject(row) {
    stringsOnly(row);
    assert.equal(row.id, 'record-001');
    assert.equal(row.portal_url, item);
    assert.deepEqual(valuesSet(row.titel), new Set(['Portalobjekt Eins', 'First portal object']));
    assert.deepEqual(valuesSet(row.beschreibung), new Set(['Objektbeschreibung', 'Ergänzung']));
    assert.deepEqual(valuesSet(row.objekttyp), new Set(['Zeichnung auf Papier', 'Drawing on paper', 'Unbekannter Typ']));
    assert.deepEqual(valuesSet(row.beteiligte), new Set(['Alice Müller', 'Bob Schneider', 'https://example.org/query/person/unlabelled']));
    assert.deepEqual(valuesSet(row.ereignisse), new Set(['Herstellung: Alice Müller (1903)', 'Restaurierung: Bob Schneider (1930)', 'Ereignis']));
    assert.deepEqual(valuesSet(row.datierung), new Set(['1901', '1920']));
    assert.deepEqual(valuesSet(row.abmessungen), new Set(['10 x 20 cm', '24 Seiten']));
    assert.deepEqual(valuesSet(row.identifikatoren), new Set(['INV 001', 'DDB-001']));
    assert.deepEqual(valuesSet(row.ort), new Set(['Berlin', 'BER']));
    assert.equal(row.aufbewahrung, 'Museum Eins');
    assert.deepEqual(valuesSet(row.datenlieferant), new Set(['Testmuseum', 'Test Museum']));
    assert.equal(row.sparte, 'Museen');
    assert.equal(row.vorschau_url, 'https://media.example/preview/0.jpg');
    assert.equal(row.original_url, 'https://media.example/original/a');
    assert.equal(row.digitalisat_url, 'https://media.example/digital/a.tif');
    assert.equal(row.digitalisat_format, 'application/tiff');
    assert.equal(row.digitalisat_rechte_url, 'https://rights.example/resource/a');
    assert.equal(row.metadaten_rechte_url, 'https://rights.example/metadata/a');
}

test('the portal example returns all 20 scalar fields through the actual browser WASM engine', async t => {
    const {engine} = await harness(t);
    const result = await engine.query({rdfXml, query: preset});
    assert.equal(result.kind, 'select');
    assert.equal(result.rowCount, 1);
    assert.deepEqual(result.variables, fields);
    assert.equal(result.tripleCount, 89);
    const rows = JSON.parse(result.json);
    assert.equal(rows.length, 1);
    assertCompleteObject(rows[0]);
});

test('each object remains isolated and missing portal values become empty strings', async t => {
    const {engine} = await harness(t);
    // Removing the object restriction must keep every object's fields separate.
    const query = preset.replace(/VALUES\s+\?objekt\s*\{\s*<[^>]+>\s*\}/u, '');
    assert.notEqual(query, preset);
    const result = await engine.query({rdfXml, query});
    assert.equal(result.rowCount, 2);
    const rows = JSON.parse(result.json);
    assertCompleteObject(rows.find(row => row.portal_url === item));
    const sparse = rows.find(row => row.portal_url === second);
    stringsOnly(sparse);
    assert.equal(sparse.id, 'second-object', 'the IRI suffix is used when the metadata record has no ID');
    assert.equal(sparse.datenlieferant, 'https://example.org/query/provider/2', 'an unlabelled provider retains its own IRI');
    for (const field of fields.filter(field => !['id', 'portal_url', 'datenlieferant'].includes(field))) {
        assert.equal(sparse[field], '', field + ' never borrows values from the first object');
    }
});

test('digital rights fall back only to aggregations containing the selected digital resource', async t => {
    const {engine} = await harness(t);
    const withoutResourceRights = rdfXml.replace(/\s*<edm:rights rdf:resource="https:\/\/rights\.example\/resource\/[az]"\/>/gu, '');
    assert.notEqual(withoutResourceRights, rdfXml);
    const result = await engine.query({rdfXml: withoutResourceRights, query: preset});
    const [row] = JSON.parse(result.json);
    assert.equal(row.digitalisat_url, 'https://media.example/digital/a.tif');
    assert.equal(row.digitalisat_format, 'application/tiff');
    assert.equal(row.digitalisat_rechte_url, 'https://rights.example/aggregation/a');
    assert.equal(row.metadaten_rechte_url, 'https://rights.example/metadata/a');
});

test('100 real portal queries reuse one loaded source and a source edit loads exactly once more', async t => {
    const {engine, counts} = await harness(t);
    let first;
    for (let i = 0; i < 100; i++) {
        const result = await engine.query({rdfXml, query: preset});
        first ||= result;
        assert.equal(result.timings.cacheHit, i !== 0);
        assert.equal(result.rowCount, 1);
    }
    assert.equal(first.timings.cacheHit, false);
    assert.deepEqual(counts, {initialize: 1, load: 1, query: 100});
    const otherObject = await engine.query({rdfXml, query: preset.replace(`<${item}>`, `<${second}>`)});
    assert.equal(otherObject.timings.cacheHit, true);
    assert.equal(JSON.parse(otherObject.json)[0].portal_url, second);
    assert.equal(counts.load, 1, 'changing only the query never reparses RDF/XML');
    const edited = await engine.query({rdfXml: rdfXml.replace('Portalobjekt Eins', 'Geänderter Titel'), query: preset});
    assert.equal(edited.timings.cacheHit, false);
    assert.deepEqual(counts, {initialize: 1, load: 2, query: 102});
    assert.ok(valuesSet(JSON.parse(edited.json)[0].titel).has('Geänderter Titel'));
    for (const field of ['initMs', 'loadMs', 'queryMs', 'serializeMs']) {
        assert.ok(Number.isFinite(first.timings[field]) && first.timings[field] >= 0, field);
    }
});

function assertMuseumObject(row) {
    stringsOnly(row);
    const grouped = {
        beteiligte: ['Hieronymus Wierix', 'Albrecht Dürer'],
        ereignisse: ['Herstellung: Hieronymus Wierix (1568-1619)', 'Entwurf (Aktivität): Albrecht Dürer (1514)'],
        datierung: ['1568-1619 (Herstellung)', '1514 (Entwurf)'],
        abmessungen: ['Platte: 114 x 72 mm', 'Blatt: 117 x 74 mm']
    };
    const scalar = {
        id: '224IOLKFSF3WLN3FUEHIBGIVX3PRYU6I', portal_url: item,
        titel: 'Tanzendes Bauernpaar', beschreibung: '', objekttyp: 'Druckgraphik',
        identifikatoren: '1851/865 (Inventarnummer)', ort: 'Bremen', aufbewahrung: 'Kunsthalle Bremen',
        datenlieferant: 'Kunsthalle Bremen - Der Kunstverein in Bremen', sparte: 'Museum',
        vorschau_url: 'https://iiif.deutsche-digitale-bibliothek.de/image/2/07c42563-7942-4ed4-ad68-ed580fb689e0/full/!300,300/0/default.jpg',
        original_url: 'https://onlinekatalog.kunsthalle-bremen.de/DE-MUS-027614/object/39580',
        digitalisat_url: 'https://onlinekatalog.kunsthalle-bremen.de/DE-MUS-027614/object/39580/114530',
        digitalisat_format: 'image/jpeg',
        digitalisat_rechte_url: 'http://creativecommons.org/publicdomain/mark/1.0/',
        metadaten_rechte_url: 'https://creativecommons.org/publicdomain/zero/1.0/'
    };
    assert.equal(Object.keys(grouped).length + Object.keys(scalar).length, 20);
    for (const [field, expected] of Object.entries(scalar)) assert.equal(row[field], expected, field);
    for (const [field, expected] of Object.entries(grouped)) assert.deepEqual(valuesSet(row[field]), new Set(expected), field);
}

test('the supplied museum record yields all 20 portal fields with correct event times and separate rights', async t => {
    const {engine} = await harness(t);
    const result = await engine.query({rdfXml: museumXml, baseIri: 'https://validator.example/query.html', query: preset});
    assert.equal(result.rowCount, 1);
    assert.equal(result.tripleCount, 115);
    assert.deepEqual(result.variables, fields);
    assertMuseumObject(JSON.parse(result.json)[0]);
});

test('source spelling errors do not get silently repaired by the query engine', async t => {
    const {engine} = await harness(t);
    // Reconstruct exactly the two misspellings in the supplied source, without changing the preset.
    const uncorrected = museumXml.replaceAll('edm:occurredAt', 'edm:occuredAt')
        .replace('rdf:about="#ddbAggregation"', 'rdf:about="#ddbAggegation"');
    const raw = await engine.query({rdfXml: uncorrected, query: preset});
    const [row] = JSON.parse(raw.json);
    stringsOnly(row);
    assert.deepEqual(valuesSet(row.ereignisse), new Set(['Herstellung: Hieronymus Wierix', 'Entwurf (Aktivität): Albrecht Dürer']));
    assert.equal(row.digitalisat_rechte_url, 'http://creativecommons.org/publicdomain/mark/1.0/');
    assert.equal(row.metadaten_rechte_url, 'https://creativecommons.org/publicdomain/zero/1.0/');
    const corrected = await engine.query({rdfXml: museumXml, query: preset});
    assert.equal(corrected.timings.cacheHit, false);
    assertMuseumObject(JSON.parse(corrected.json)[0]);
});

test('the museum source keeps its XML base through cached queries, source changes and failed replacements', async t => {
    const {engine, counts} = await harness(t);
    const source = {rdfXml: museumXml, baseIri: 'https://validator.example/query.html'};
    await engine.query({...source, query: preset});
    const baseCheck = await engine.query({...source, query: `
        PREFIX ore: <http://www.openarchives.org/ore/terms/>
        ASK { <https://api.deutsche-digitale-bibliothek.de/items/224IOLKFSF3WLN3FUEHIBGIVX3PRYU6I#dataProviderProxy>
          ore:proxyIn <https://api.deutsche-digitale-bibliothek.de/items/224IOLKFSF3WLN3FUEHIBGIVX3PRYU6I#dataProviderAggregation> }`});
    assert.equal(baseCheck.json, 'true', 'xml:base overrides the page URL for fragment identifiers');
    assert.equal(baseCheck.timings.cacheHit, true);
    const repeat = await engine.query({...source, query: preset + '\n# query-only edit'});
    assert.equal(repeat.timings.loadMs, 0);
    assert.deepEqual(counts, {initialize: 1, load: 1, query: 3});
    const changedSource = {...source, rdfXml: museumXml.replace('Tanzendes Bauernpaar', 'Geänderter Titel')};
    const changed = await engine.query({...changedSource, query: preset});
    assert.equal(JSON.parse(changed.json)[0].titel, 'Geänderter Titel');
    assert.equal(changed.timings.cacheHit, false);
    await assert.rejects(engine.query({...changedSource, query: 'not SPARQL'}), error => error.phase === 'querying');
    await assert.rejects(engine.query({...source, rdfXml: '<broken>', query: preset}), error => error.phase === 'loading');
    const restored = await engine.query({...source, query: preset});
    assertMuseumObject(JSON.parse(restored.json)[0]);
    assert.equal(counts.initialize, 1);
    assert.equal(counts.load, 4);
});

test('metadata rights stay paired with the record selected by its smallest item ID', async t => {
    const {engine} = await harness(t);
    const extraRecord = `
  <ore:Aggregation rdf:about="urn:other-metadata-aggregation">
    <edm:aggregatedCHO rdf:resource="${item}"/>
    <bf:adminMetadata rdf:resource="urn:other-metadata-record"/>
  </ore:Aggregation>
  <rdf:Description rdf:about="urn:other-metadata-record">
    <ddb:itemId>zzz-record-2</ddb:itemId>
    <dcterms:rights rdf:resource="https://rights.example/metadata/0-other-record"/>
  </rdf:Description>
`;
    const source = rdfXml.replace('</rdf:RDF>', extraRecord + '</rdf:RDF>');
    assert.notEqual(source, rdfXml);
    const result = await engine.query({rdfXml: source, query: preset});
    assert.equal(result.rowCount, 1, 'another metadata record must not duplicate the selected object');
    const [row] = JSON.parse(result.json);
    assert.equal(row.id, 'record-001');
    assert.equal(row.metadaten_rechte_url, 'https://rights.example/metadata/a',
        'the lexically smaller rights URL of zzz-record-2 does not belong to record-001');
    assertCompleteObject(row);
    const missingRights = source.replace(/\s*<dcterms:rights rdf:resource="https:\/\/rights\.example\/metadata\/[az]"\/>/gu, '');
    const missing = await engine.query({rdfXml: missingRights, query: preset});
    const [withoutOwnRights] = JSON.parse(missing.json);
    assert.equal(withoutOwnRights.id, 'record-001');
    assert.equal(withoutOwnRights.metadaten_rechte_url, '', 'missing rights never borrow another record’s license');
    assertCompleteObject({...withoutOwnRights, metadaten_rechte_url: row.metadaten_rechte_url});
});

test('text aggregation combines eligible provider proxies without duplicates or unrelated proxy data', async t => {
    const {engine} = await harness(t);
    const proxies = `
  <ore:Proxy rdf:about="urn:additional-provider-proxy">
    <ore:proxyFor rdf:resource="${item}"/>
    <ore:proxyIn rdf:resource="https://example.org/query/aggregation/provider-1"/>
    <dc:title>Portalobjekt Eins</dc:title>
    <dc:title>Zusätzlicher Titel</dc:title>
    <dc:creator><edm:Agent/></dc:creator>
  </ore:Proxy>
  <ore:Proxy rdf:about="urn:ddb-proxy">
    <ore:proxyFor rdf:resource="${item}"/>
    <ore:proxyIn rdf:resource="https://example.org/query/#ddbAggregation"/>
    <dc:title>Kein Titel des Datenlieferanten</dc:title>
  </ore:Proxy>
  <rdf:Description rdf:about="urn:untyped-proxy">
    <ore:proxyFor rdf:resource="${item}"/>
    <ore:proxyIn rdf:resource="https://example.org/query/aggregation/provider-1"/>
    <dc:title>Kein typisierter Proxy</dc:title>
  </rdf:Description>
`;
    const result = await engine.query({rdfXml: rdfXml.replace('</rdf:RDF>', proxies + '</rdf:RDF>'), query: preset});
    assert.equal(result.rowCount, 1);
    const [row] = JSON.parse(result.json);
    const titles = row.titel.split('; ');
    assert.deepEqual(new Set(titles), new Set(['Portalobjekt Eins', 'First portal object', 'Zusätzlicher Titel']));
    assert.equal(titles.length, 3, 'a shared title appears only once across provider proxies');
    const originalTitles = titles.filter(title => title !== 'Zusätzlicher Titel').join('; ');
    assertCompleteObject({...row, titel: originalTitles});
});
