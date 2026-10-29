package de.ddb.edmvalidator.service;

import com.apicatalog.jsonld.JsonLd;
import com.apicatalog.jsonld.document.JsonDocument;
import de.ddb.edmvalidator.api.ConversionRequest;
import de.ddb.edmvalidator.api.ConversionResponse;
import de.ddb.edmvalidator.api.ConversionResult;
import jakarta.json.Json;
import jakarta.json.JsonObject;
import jakarta.json.JsonValue;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFDataMgr;
import org.apache.jena.riot.RDFParser;
import org.apache.jena.riot.system.StreamRDFBase;
import org.apache.jena.sparql.core.Quad;
import org.junit.jupiter.api.Test;
import org.jspecify.annotations.NonNull;
import org.jspecify.annotations.Nullable;
import org.w3c.dom.Element;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.*;
import static java.util.Objects.requireNonNull;

class RdfConversionServiceTest {
    private static final String ORGANISATION = "https://example.org/organisation";
    private static final String ADDRESS = "https://example.org/adresse";
    private static final String VCARD = "http://www.w3.org/2006/vcard/ns#";
    private static final String EX = "https://example.org/vocabulary/";
    private static final String PART_ROOT = "https://example.org/root";
    private static final String PART = "https://example.org/part";
    private static final String DDB_ID = "224IOLKFSF3WLN3FUEHIBGIVX3PRYU6I";
    private static final String OTHER_DDB_ID = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    private static final String RECORDS = "https://api.deutsche-digitale-bibliothek.de/records/";
    private static final String ITEMS = "https://api.deutsche-digitale-bibliothek.de/items/";
    private static final String CONTEXT = """
            {"@context": {
              "schema": {"@id": "http://schema.org/", "@prefix": true},
              "vcard": {"@id": "http://www.w3.org/2006/vcard/ns#", "@prefix": true}
            }}
            """;
    private final RdfConversionService service = new RdfConversionService();

    @Test
    void missingOutputFlagsDefaultToXmlAndExplicitFlagsSelectOnlyTrueFormats() throws Exception {
        Options options = new Options(fixture());
        options.rdfXmlOutput = null;
        options.jsonLdOutput = null;
        assertEquals(List.of("rdfxml"), service.convert(options.request()).results().stream().map(ConversionResult::id).toList());
        options.jsonLdOutput = true;
        assertEquals(List.of("compacted"), service.convert(options.request()).results().stream().map(ConversionResult::id).toList());
        options.jsonLdOutput = null;
        options.nQuadsOutput = true;
        assertEquals(List.of("nquads"), service.convert(options.request()).results().stream().map(ConversionResult::id).toList());
        options.nQuadsOutput = null;
        options.trigOutput = true;
        assertEquals(List.of("trig"), service.convert(options.request()).results().stream().map(ConversionResult::id).toList());
        options.rdfXmlOutput = false;
        options.jsonLdOutput = false;
        options.nQuadsOutput = false;
        options.trigOutput = false;
        ConversionResponse none = service.convert(options.request());
        assertTrue(none.results().isEmpty());
        assertEquals("outputs", none.errors().getFirst().field());
        options.jsonLdOutput = null;
        options.nQuadsOutput = null;
        options.trigOutput = null;
        assertEquals("outputs", service.convert(options.request()).errors().getFirst().field(),
                "An explicit false flag does not re-enable implicit defaults");
    }

    @Test
    void datasetFormatsPreserveOneNamedGraphAndRdfTermsWhileIgnoringUnselectedFormatOptions() {
        String longLiteral = "München & Straße 😀 ".repeat(240) + "\nline\rreturn\ttab \"quoted\" \\backslash";
        String xmlLiteral = longLiteral.replace("&", "&amp;").replace("\r", "&#13;").replace("\t", "&#9;");
        String xml = """
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                         xmlns:ex="https://example.org/vocabulary/" xml:base="https://example.org/source/">
                  <rdf:Description rdf:about="München">
                    <ex:part rdf:nodeID="part"/><ex:name xml:lang="de">München &amp; Straße</ex:name>
                    <ex:number rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">007</ex:number>
                    <ex:long>%s</ex:long>
                    <ex:markup rdf:parseType="Literal"><span xmlns="urn:literal:markup" title="a &quot;quote&quot;">line 1
                line 2 &amp; more</span></ex:markup>
                    <ex:raw>  leading
                trailing  </ex:raw>
                  </rdf:Description>
                  <rdf:Description rdf:nodeID="part"><ex:parent rdf:resource="München"/></rdf:Description>
                </rdf:RDF>
                """.formatted(xmlLiteral);
        Options options = new Options(xml);
        options.rdfXmlOutput = false;
        options.jsonLdOutput = false;
        options.xmlRepresentation = "not-an-xml-option";
        options.xmlStructure = "not-an-xml-option";
        options.representation = "not-a-json-option";
        options.methods = List.of("not-a-json-method");
        options.contextMode = "custom";
        options.context = "{\"@context\":\"http://127.0.0.1:1/never-fetch\"}";
        options.frameMode = "custom";
        options.frame = "invalid JSON";

        for (String format : List.of("nquads", "trig")) {
            options.nQuadsOutput = format.equals("nquads");
            options.trigOutput = format.equals("trig");
            ConversionResponse response = service.convert(options.request());

            assertTrue(response.errors().isEmpty(), () -> response.errors().toString());
            assertEquals(1, response.results().size());
            ConversionResult result = successful(response, format);
            assertEquals(format.equals("nquads") ? "converted.nq" : "converted.trig", result.fileName());
            assertEquals(format.equals("nquads") ? "application/n-quads" : "application/trig", result.mediaType());
            assertEquals(content(result).getBytes(StandardCharsets.UTF_8).length, result.sizeBytes());
            assertFalse(result.empty(), "The empty flag denotes unmatched frames, not a graph format");
            assertTrue(content(result).contains("München & Straße"));
            assertTrue(content(result).contains("\"007\"^^<http://www.w3.org/2001/XMLSchema#integer>"));
            for (String escaped : List.of("\\n", "\\r", "\\t", "\\\"quoted\\\"", "\\\\backslash")) {
                assertTrue(content(result).contains(escaped), "Dump literals escape " + escaped + " without adding physical lines");
            }
            assertNull(response.zipBase64());
            assertDatasetGraph(xml, result);
        }
    }

    @Test
    void emptyDatasetFormatsKeepTheirIdentityAndTriGStillContainsOnePhysicalGraphLine() {
        Options options = new Options(rdf(""));
        options.rdfXmlOutput = false;
        options.jsonLdOutput = true;
        options.methods = List.of("expanded", "compacted", "flattened", "framed");
        options.rootIri = "https://example.org/no-match";
        options.nQuadsOutput = true;
        options.trigOutput = true;
        ConversionResponse response = service.convert(options.request());
        ConversionResult empty = successful(response, "nquads");
        assertEquals("", content(empty));
        assertEquals(0, empty.sizeBytes());
        assertFalse(empty.empty());
        assertDatasetGraph(options.rdfXml, empty);
        ConversionResult trig = successful(response, "trig");
        assertEquals(empty.graphIri(), trig.graphIri());
        assertTrue(content(trig).contains("<" + trig.graphIri() + ">"));
        assertTrue(content(trig).matches("(?s).*\\{\\s*}\\n"), "An empty record still has an explicit graph block");
        assertDatasetGraph(options.rdfXml, trig);
        for (String method : options.methods) {
            ConversionResult json = successful(response, method);
            assertEquals(empty.graphIri(), json.graphIri());
            assertTrue(jsonGraphNodes(json).isEmpty(), method + " serializes an explicit named empty graph");
            assertEquals(method.equals("framed"), json.empty(), "The empty marker remains specific to no-match framing");
            assertDatasetGraph(options.rdfXml, json);
        }
        options.rdfXml = "<rdf:RDF>";
        ConversionResponse invalid = service.convert(options.request());
        assertTrue(invalid.results().isEmpty());
        assertEquals("rdfXml", invalid.errors().getFirst().field());
    }

    @Test
    void allFourFormatsCanBeArchivedWithoutChangingTheSourceGraphAndSurviveIndependentWriterFailures() throws Exception {
        Options options = new Options(fixture());
        options.nQuadsOutput = true;
        options.trigOutput = true;
        ConversionResponse all = service.convert(options.request());
        assertTrue(all.errors().isEmpty(), () -> all.errors().toString());
        assertEquals(java.util.Set.of("rdfxml", "nquads", "trig", "compacted"), byId(all).keySet());
        assertArchiveMatchesResults(all);
        assertDatasetGraph(fixture(), successful(all, "nquads"));
        assertDatasetGraph(fixture(), successful(all, "trig"));
        assertEquals(successful(all, "nquads").graphIri(), successful(all, "trig").graphIri());
        assertNull(successful(all, "rdfxml").graphIri());
        assertEquals(successful(all, "nquads").graphIri(), successful(all, "compacted").graphIri());
        Model expected = read(fixture(), Lang.RDFXML);
        Model xml = read(content(successful(all, "rdfxml")), Lang.RDFXML);
        Model json = namedGraph(successful(all, "compacted"));
        try {
            assertTrue(expected.isIsomorphicWith(xml), "Dataset writers do not mutate the shared RDF/XML model");
            assertTrue(expected.isIsomorphicWith(json), "All dataset formats contain the same complete source graph");
        } finally {
            expected.close();
            xml.close();
            json.close();
        }

        options.contextMode = "custom";
        options.context = "{invalid JSON";
        ConversionResponse failedJson = service.convert(options.request());
        assertNotNull(byId(failedJson).get("compacted").error());
        successful(failedJson, "rdfxml");
        assertDatasetGraph(fixture(), successful(failedJson, "nquads"));
        assertDatasetGraph(fixture(), successful(failedJson, "trig"));
        assertArchiveMatchesResults(failedJson);

        options = new Options("""
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="http://example.test">
                  <rdf:Description rdf:about="https://example.org/resource"><ex:label>Text</ex:label></rdf:Description>
                </rdf:RDF>
                """);
        options.nQuadsOutput = true;
        options.trigOutput = true;
        options.xmlRepresentation = "explicit";
        options.xmlStructure = "flat";
        ConversionResponse failedXml = service.convert(options.request());
        assertNotNull(byId(failedXml).get("rdfxml").error());
        successful(failedXml, "compacted");
        assertDatasetGraph(options.rdfXml, successful(failedXml, "nquads"));
        assertDatasetGraph(options.rdfXml, successful(failedXml, "trig"));
        assertArchiveMatchesResults(failedXml);
    }

    @Test
    void datasetGraphIdentityPrefersUnambiguousDdbRecordsThenProvidedChoThenDocumentAndBase() {
        String existingRecord = "http://api.deutsche-digitale-bibliothek.de/records/" + DDB_ID;
        Options options = datasetOptions(ddbSource(DDB_ID, existingRecord));
        options.documentIri = "https://example.org/original/source.rdf";
        options.baseIri = "https://example.org/parser/base/";
        assertGraphIdentity(options, ITEMS + DDB_ID);

        options.rdfXml = ddbSource(DDB_ID, null);
        assertGraphIdentity(options, ITEMS + DDB_ID);

        options.rdfXml = ddbSource(DDB_ID, existingRecord).replace("</rdf:RDF>",
                "<rdf:Description rdf:about=\"" + ITEMS + DDB_ID + "\"><ex:label>Record</ex:label></rdf:Description></rdf:RDF>");
        assertGraphIdentity(options, ITEMS + DDB_ID);

        // Inferring an export name never rewrites an old record IRI inside the source data.
        ConversionResponse sourceRetained = service.convert(options.request());
        assertDatasetGraph(options.rdfXml, successful(sourceRetained, "compacted"));
        assertTrue(content(successful(sourceRetained, "nquads")).contains("<" + existingRecord + ">"));

        // The model contains a second, conflicting CHO: do not pick whichever iterator visits first.
        options.rdfXml = ddbSource(DDB_ID, null).replace("</rdf:RDF>", """
                <rdf:Description rdf:about="https://www.deutsche-digitale-bibliothek.de/resource/%s">
                  <rdf:type rdf:resource="http://www.europeana.eu/schemas/edm/ProvidedCHO"/>
                </rdf:Description></rdf:RDF>
                """.formatted(OTHER_DDB_ID));
        assertGraphIdentity(options, options.documentIri);

        options.rdfXml = ddbSource(DDB_ID, RECORDS + OTHER_DDB_ID);
        assertGraphIdentity(options, options.documentIri);

        options.rdfXml = rdf("<rdf:Description rdf:about=\"https://example.org/item\"><ex:label>Text</ex:label></rdf:Description>");
        assertGraphIdentity(options, options.documentIri);
        options.documentIri = null;
        assertGraphIdentity(options, options.baseIri);
        options.documentIri = "http://api.deutsche-digitale-bibliothek.de/records/" + DDB_ID;
        assertGraphIdentity(options, ITEMS + DDB_ID);
        options.documentIri = null;
        options.baseIri = "http://api.deutsche-digitale-bibliothek.de/items/" + DDB_ID;
        assertGraphIdentity(options, ITEMS + DDB_ID);
        options.documentIri = ITEMS + DDB_ID + "/edm";
        assertGraphIdentity(options, ITEMS + DDB_ID);
    }

    @Test
    void graphIdentityHashesTheOriginalSourceWhenNoUnambiguousIdentityExists() throws Exception {
        Options options = datasetOptions(ddbSource(DDB_ID, RECORDS + OTHER_DDB_ID));
        String expected = "urn:sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(options.rdfXml.getBytes(StandardCharsets.UTF_8)));
        assertGraphIdentity(options, expected);
        assertGraphIdentity(options, expected);
        options.rdfXml += "\n";
        String changed = successful(service.convert(options.request()), "trig").graphIri();
        assertNotEquals(expected, changed, "The fallback hashes exact source bytes rather than a normalized model");
    }

    @Test
    void concatenatingRecordExportsDoesNotJoinBlankNodesFromDifferentNamedGraphs() {
        ConversionResponse first = service.convert(datasetOptions(ddbSource(DDB_ID, null)).request());
        ConversionResponse second = service.convert(datasetOptions(ddbSource(OTHER_DDB_ID, null)).request());
        for (String format : List.of("nquads", "trig", "compacted")) {
            ConversionResult a = successful(first, format);
            ConversionResult b = successful(second, format);
            var dataset = DatasetFactory.createTxnMem();
            try {
                String combined = content(a) + content(b);
                if (format.equals("compacted")) {
                    var documents = Json.createArrayBuilder();
                    expandedJson(a).forEach(documents::add);
                    expandedJson(b).forEach(documents::add);
                    combined = documents.build().toString();
                }
                RDFDataMgr.read(dataset, new StringReader(combined), "https://unrelated.invalid/export", datasetLanguage(a));
                assertTrue(dataset.getDefaultModel().isEmpty());
                Model graphA = dataset.getNamedModel(requireNonNull(a.graphIri()));
                Model graphB = dataset.getNamedModel(requireNonNull(b.graphIri()));
                var blanksA = new HashSet<org.apache.jena.graph.Node>();
                var blanksB = new HashSet<org.apache.jena.graph.Node>();
                graphA.listSubjects().forEachRemaining(node -> { if (node.isAnon()) blanksA.add(node.asNode()); });
                graphB.listSubjects().forEachRemaining(node -> { if (node.isAnon()) blanksB.add(node.asNode()); });
                assertEquals(1, blanksA.size());
                assertEquals(1, blanksB.size());
                assertTrue(java.util.Collections.disjoint(blanksA, blanksB),
                        "RDF blank labels are document-scoped, so independently exported records need disjoint labels");
                Model expectedA = read(ddbSource(DDB_ID, null), Lang.RDFXML);
                Model expectedB = read(ddbSource(OTHER_DDB_ID, null), Lang.RDFXML);
                try {
                    assertTrue(graphA.isIsomorphicWith(expectedA));
                    assertTrue(graphB.isIsomorphicWith(expectedB));
                } finally {
                    expectedA.close();
                    expectedB.close();
                }
            } finally {
                dataset.close();
            }
        }
    }

    @Test
    void resourceMetadataIsSortedDistinctAndContainsOnlyNamedSubjectsAndObjects() {
        Options options = new Options("""
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="https://example.org/vocabulary/">
                  <rdf:Description rdf:about="https://example.org/z">
                    <ex:link rdf:resource="https://example.org/a"/><ex:link rdf:nodeID="blank"/><ex:label>text</ex:label>
                  </rdf:Description>
                  <rdf:Description rdf:about="https://example.org/a"><ex:link rdf:resource="https://example.org/z"/></rdf:Description>
                  <rdf:Description rdf:nodeID="blank"><ex:link rdf:resource="https://example.org/a"/></rdf:Description>
                </rdf:RDF>
                """);

        ConversionResponse response = service.inspect(options.request());

        assertTrue(response.errors().isEmpty(), () -> response.errors().toString());
        assertEquals(List.of("https://example.org/a", "https://example.org/z"), response.resources());
    }

    @Test
    void allXmlRepresentationsAndStructuresAreIndentedAndPreserveTheCompleteGraphAndLiteralWhitespace() throws Exception {
        String xml = fixture().replace("</rdf:RDF>", """
                <rdf:Description rdf:about="https://example.org/whitespace">
                  <ex:raw>  führend
                 \tinnen

                nachfolgend  </ex:raw>
                  <ex:xml rdf:parseType="Literal">  <span xmlns="urn:literal" xmlns:p="urn:markup:" z="last" a="first">a
                <p:line xml:lang="de">b &amp; c</p:line><rdf:Description rdf:about="literal-relative-id"/></span>  </ex:xml>
                </rdf:Description>
                <ex:Collection rdf:about="https://example.org/collection">
                  <ex:members rdf:parseType="Collection">
                    <ex:Member rdf:about="https://example.org/member">
                      <ex:info rdf:parseType="Resource">
                        <ex:entry><ex:Detail rdf:about="https://example.org/detail"><ex:text>Detail</ex:text></ex:Detail></ex:entry>
                      </ex:info>
                    </ex:Member>
                    <ex:Member rdf:about="https://example.org/member2"/>
                  </ex:members>
                </ex:Collection>
                </rdf:RDF>
                """);
        Model input = read(xml, Lang.RDFXML);
        for (String representation : List.of("explicit", "typed")) {
            for (String structure : List.of("flat", "nested")) {
                Options options = new Options(xml);
                options.jsonLdOutput = false;
                options.xmlRepresentation = representation;
                options.xmlStructure = structure;
                ConversionResponse response = assertTimeoutPreemptively(requireNonNull(Duration.ofSeconds(10)), () -> service.convert(options.request()));
                assertTrue(response.errors().isEmpty(), response.errors().toString());
                ConversionResult result = successful(response, "rdfxml");
                assertEquals("converted.rdf", result.fileName());
                assertEquals("application/rdf+xml", result.mediaType());
                assertEquals(content(result).getBytes(StandardCharsets.UTF_8).length, result.sizeBytes());
                Model output = read(content(result), Lang.RDFXML);
                assertTrue(input.isIsomorphicWith(output), representation + " / " + structure);
                assertTrue(content(result).lines().anyMatch(line -> line.startsWith("  <")), "Every XML output is indented");
                for (String property : List.of("raw", "xml")) {
                    assertEquals(input.getProperty(input.createResource("https://example.org/whitespace"), input.createProperty(EX + property)).getLiteral().getLexicalForm(),
                            output.getProperty(output.createResource("https://example.org/whitespace"), output.createProperty(EX + property)).getLiteral().getLexicalForm(), property);
                }
                var document = xmlDocument(content(result));
                assertEquals(representation.equals("typed") ? 2 : 0,
                        document.getElementsByTagNameNS("http://schema.org/", "Organization").getLength());
                assertEquals(representation.equals("typed") ? 2 : 0,
                        document.getElementsByTagNameNS(EX, "Member").getLength(), "Representation also applies inside RDF collections");
                assertEquals(representation.equals("typed") ? 1 : 0,
                        document.getElementsByTagNameNS(EX, "Detail").getLength(), "Representation also applies below implicit blank nodes");
                if (structure.equals("nested")) {
                    Element property = (Element) document.getElementsByTagNameNS(VCARD, "hasAddress").item(0);
                    Element nested = null;
                    for (var child = property.getFirstChild(); child != null; child = child.getNextSibling()) {
                        if (child instanceof Element element) { nested = element; break; }
                    }
                    assertNotNull(nested, "Both node representations can nest the named address for this graph");
                    assertEquals(ADDRESS, nested.getAttributeNS("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "about"));
                    assertEquals(representation.equals("typed") ? "Address" : "Description", nested.getLocalName());
                } else {
                    for (var child = document.getDocumentElement().getFirstChild(); child != null; child = child.getNextSibling()) {
                        if (!(child instanceof Element resource)) continue;
                        for (var field = resource.getFirstChild(); field != null; field = field.getNextSibling()) {
                            if (!(field instanceof Element property) || "Literal".equals(property.getAttributeNS("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "parseType"))) continue;
                            for (var value = property.getFirstChild(); value != null; value = value.getNextSibling()) {
                                assertFalse(value instanceof Element, "Flat mode keeps linked resource descriptions at the top level");
                            }
                        }
                    }
                }
            }
        }
    }

    @Test
    void typedFlatXmlHandlesMultipleTypesBlankNodesAndTypesThatCannotBeXmlElements() throws Exception {
        String xml = rdf("""
                <rdf:Description rdf:about="https://example.org/multiple">
                  <rdf:type rdf:resource="https://example.net/types/Zebra"/>
                  <rdf:type rdf:resource="https://example.net/types/Alpha"/>
                  <ex:link rdf:nodeID="shared"/>
                </rdf:Description>
                <rdf:Description rdf:nodeID="shared">
                  <rdf:type rdf:resource="https://example.net/types/Part"/>
                  <ex:link rdf:resource="https://example.org/multiple"/>
                </rdf:Description>
                <rdf:Description rdf:about="https://example.org/noQName">
                  <rdf:type rdf:resource="https://example.net/types/123"/>
                </rdf:Description>
                <rdf:Description rdf:about="https://example.org/descriptionType">
                  <rdf:type rdf:resource="http://www.w3.org/1999/02/22-rdf-syntax-ns#Description"/>
                  <rdf:type rdf:resource="http://www.w3.org/1999/02/22-rdf-syntax-ns#RDF"/>
                  <rdf:type rdf:resource="http://www.w3.org/1999/02/22-rdf-syntax-ns#li"/>
                  <rdf:type rdf:resource="http://www.w3.org/1999/02/22-rdf-syntax-ns#bagID"/>
                  <rdf:type rdf:resource="http://www.w3.org/2000/xmlns/Thing"/>
                </rdf:Description>
                <rdf:Description rdf:about="https://example.org/statementType">
                  <rdf:type rdf:resource="http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement"/>
                </rdf:Description>
                <rdf:Description rdf:about="https://example.org/untyped"><ex:link rdf:nodeID="shared"/></rdf:Description>
                """);
        Options options = new Options(xml);
        options.jsonLdOutput = false;
        options.xmlRepresentation = "typed";
        options.xmlStructure = "flat";
        String output = content(successful(service.convert(options.request()), "rdfxml"));
        assertTrue(read(xml, Lang.RDFXML).isIsomorphicWith(read(output, Lang.RDFXML)), output);
        var document = xmlDocument(output);
        assertEquals(1, document.getElementsByTagNameNS("https://example.net/types/", "Alpha").getLength(), "A deterministic valid type becomes the node name");
        assertEquals(1, document.getElementsByTagNameNS("https://example.net/types/", "Part").getLength(), "Typed blank nodes stay blank nodes");
        assertEquals(1, document.getElementsByTagNameNS("http://www.w3.org/1999/02/22-rdf-syntax-ns#", "Statement").getLength(), "Usable standard RDF classes are supported");
        int resources = 0;
        for (var child = document.getDocumentElement().getFirstChild(); child != null; child = child.getNextSibling()) {
            if (child instanceof Element) resources++;
        }
        assertEquals(6, resources, "All named and blank resources remain separate top-level nodes");
    }

    @Test
    void xmlIsAlwaysIndentedAndOmittedOptionsUseTheDdbDefaults() throws Exception {
        Options options = new Options(fixture());
        options.jsonLdOutput = false;
        String defaultXml = content(successful(service.convert(options.request()), "rdfxml"));
        options.xmlRepresentation = "explicit";
        options.xmlStructure = "flat";
        String indented = content(successful(service.convert(options.request()), "rdfxml"));
        var defaults = xmlDocument(defaultXml);
        assertEquals(2, defaults.getElementsByTagNameNS("http://schema.org/", "Organization").getLength(),
                "Omitted representation uses typed elements");
        Element address = (Element) defaults.getElementsByTagNameNS(VCARD, "Address").item(0);
        assertSame(defaults.getDocumentElement(), address.getParentNode(), "Omitted structure keeps linked resources flat");
        assertTrue(defaultXml.lines().anyMatch(line -> line.startsWith("  <schema:Organization")),
                "XML output always uses indentation");
        assertTrue(indented.lines().anyMatch(line -> line.startsWith("  <rdf:Description")));
        assertTrue(read(defaultXml, Lang.RDFXML).isIsomorphicWith(read(indented, Lang.RDFXML)));
    }

    @Test
    void invalidXmlSettingsOnlyFailXmlWhenJsonLdWasAlsoRequested() throws Exception {
        Options options = new Options(fixture());
        options.xmlRepresentation = "not-supported";
        options.xmlStructure = "not-supported";
        ConversionResponse response = service.convert(options.request());
        assertEquals(java.util.Set.of("xmlRepresentation", "xmlStructure"), response.errors().stream().map(issue -> issue.field()).collect(Collectors.toSet()));
        assertNotNull(byId(response).get("rdfxml").error());
        successful(response, "compacted");
        options.rdfXmlOutput = false;
        response = service.convert(options.request());
        assertTrue(response.errors().isEmpty(), "Unused XML options must not affect JSON-LD");
        successful(response, "compacted");
    }

    @Test
    void writerErrorsIdentifyDerivedNamespacesAndSourcePrefixesWithoutChangingDataOrOtherOutputs() {
        String xml = """
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:bad="http://example.test">
                  <rdf:Description rdf:about="https://example.org/record">
                    <bad:label xml:lang="de">Unveränderter Wert</bad:label>
                  </rdf:Description>
                </rdf:RDF>
                """;
        for (String representation : List.of("explicit", "typed")) {
            for (String structure : List.of("flat", "nested")) {
                Options options = new Options(xml);
                options.xmlRepresentation = representation;
                options.xmlStructure = structure;
                ConversionResponse response = service.convert(options.request());
                assertTrue(response.errors().isEmpty(), response.errors().toString());
                ConversionResult failure = byId(response).get("rdfxml");
                assertNull(failure.content());
                assertNotNull(failure.error());
                assertTrue(failure.error().startsWith("RDF/XML konnte nicht geschrieben werden:"), failure.error());
                for (String context : List.of("Not an RDF IRI: <http://>", "http://example.testlabel",
                        "bad:label", "xmlns:bad=\"http://example.test\"", "https://example.org/record")) {
                    assertTrue(failure.error().contains(context), context + " missing from " + failure.error());
                }
                assertTrue(failure.error().contains("abgeleitet"), "The namespace must be identified as derived, not as a graph IRI");
                ConversionResult json = successful(response, "compacted");
                assertTrue(read(xml, Lang.RDFXML).isIsomorphicWith(namedGraph(json)),
                        "Diagnostic reporting must not alter or suppress an independent JSON-LD output");
                assertEquals("http://example.test", jsonObject(response.autoContext()).getJsonObject("@context")
                        .getJsonObject("bad").getString("@id"));
                assertTrue(service.inspect(options.request()).errors().isEmpty(), "Diagnostics only run after a writer failure");
            }
        }
    }

    @Test
    void representationAndStructureAreIndependentAcrossAllSixCombinations() throws Exception {
        Model input = read(fixture(), Lang.RDFXML);
        Model compactFrame = null;
        for (String structure : List.of("standard", "flattened", "framed")) {
            for (String representation : List.of("compacted", "expanded")) {
                Options options = new Options(fixture());
                options.rdfXmlOutput = false;
                options.representation = representation;
                String method = structure.equals("standard") ? representation : structure;
                options.methods = List.of(method);
                options.rootIri = ORGANISATION;
                options.embed = "@once";
                options.contextMode = "custom";
                options.context = CONTEXT;
                ConversionResponse response = assertTimeoutPreemptively(requireNonNull(Duration.ofSeconds(20)),
                        () -> service.convert(options.request()));
                assertTrue(response.errors().isEmpty(), () -> response.errors().toString());
                assertEquals(1, response.results().size());
                ConversionResult result = successful(response, method);
                assertTrue(content(result).lines().anyMatch(line -> line.startsWith(" ")), "Every JSON-LD output is formatted");
                assertEquals(structure.equals("standard") ? representation + ".jsonld"
                        : structure + "-" + representation + ".jsonld", result.fileName());
                JsonValue document = jsonValue(content(result));
                assertEquals(representation.equals("compacted"), hasKey(document, "@context"));
                Model output = namedGraph(result);
                if (!structure.equals("framed")) {
                    assertTrue(input.isIsomorphicWith(output), structure + " / " + representation);
                    if (structure.equals("flattened")) {
                        var nodes = jsonGraphNodes(result);
                        assertTrue(nodes.size() >= 5, "Flattening keeps separate resource descriptions");
                    }
                } else {
                    assertTrue(output.size() < input.size(), "The frame intentionally selects part of the graph");
                    JsonObject organisation = findById(document, ORGANISATION);
                    assertNotNull(organisation);
                    JsonValue value = organisation.get(representation.equals("compacted")
                            ? "vcard:hasAddress" : VCARD + "hasAddress");
                    if (value instanceof jakarta.json.JsonArray array) value = array.getFirst();
                    assertInstanceOf(JsonObject.class, value);
                    JsonObject address = (JsonObject) value;
                    assertEquals(ADDRESS, address.getString("@id"));
                    assertTrue(address.size() > 1, "The named address remains embedded after expansion");
                    if (compactFrame == null) compactFrame = output;
                    else assertTrue(compactFrame.isIsomorphicWith(output), "Representation must not alter the selected graph");
                }
            }
        }
    }

    @Test
    void everyJsonLdRepresentationPreservesNamedGraphLiteralTermsAndKeywordAliases() {
        String xml = rdf("""
                <rdf:Description rdf:about="https://example.org/root">
                  <ex:label xml:lang="de">München &amp; Straße 😀
                LF&#13;CR&#9;Tab "quote" \\slash</ex:label>
                  <ex:number rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">007</ex:number>
                  <ex:markup rdf:parseType="Literal"><span xmlns="urn:literal:markup">a
                b &amp; c</span></ex:markup>
                  <ex:part rdf:nodeID="part"/>
                </rdf:Description>
                <rdf:Description rdf:nodeID="part"><ex:label>Teil</ex:label></rdf:Description>
                """);
        String context = "{\"@context\":{\"identifier\":\"@id\",\"nodes\":\"@graph\",\"ex\":{\"@id\":\"" + EX + "\",\"@prefix\":true}}}";
        Model expected = read(xml, Lang.RDFXML);
        try {
            for (String structure : List.of("standard", "flattened", "framed")) {
                for (String representation : List.of("compacted", "expanded")) {
                    Options options = new Options(xml);
                    options.rdfXmlOutput = false;
                    options.documentIri = "https://example.org/source/record.rdf";
                    options.methods = List.of(structure.equals("standard") ? representation : structure);
                    options.representation = representation;
                    options.contextMode = "custom";
                    options.context = context;
                    options.frameMode = "custom";
                    options.frame = "{\"@context\":" + jsonObject(context).getJsonObject("@context")
                            + ",\"@id\":\"https://example.org/root\",\"@embed\":\"@always\"}";
                    ConversionResult result = successful(service.convert(options.request()), options.methods.getFirst());
                    assertEquals(options.documentIri, result.graphIri());
                    Model actual = namedGraph(result);
                    try {
                        assertTrue(expected.isIsomorphicWith(actual), structure + " / " + representation + " preserves lexical RDF terms");
                    } finally {
                        actual.close();
                    }
                    if (representation.equals("compacted")) {
                        JsonObject aliases = jsonObject(content(result)).getJsonObject("@context");
                        assertEquals("@id", aliases.getString("identifier"));
                        assertEquals("@graph", aliases.getString("nodes"));
                    }
                }
            }
        } finally {
            expected.close();
        }
    }

    @Test
    void representationControlsFlattenContextAndExpandedFrameStillUsesItsOwnContext() throws Exception {
        Options options = new Options(fixture());
        options.rdfXmlOutput = false;
        options.methods = List.of("flattened");
        options.contextMode = "custom";
        options.context = "{broken";
        options.representation = "compacted";
        ConversionResponse compact = service.convert(options.request());
        assertNotNull(byId(compact).get("flattened").error());
        assertTrue(compact.errors().stream().anyMatch(issue -> issue.field().equals("context")));
        assertEquals("flattened-compacted.jsonld", byId(compact).get("flattened").fileName());

        options.representation = "expanded";
        ConversionResponse expanded = service.convert(options.request());
        assertTrue(expanded.errors().isEmpty());
        successful(expanded, "flattened");

        options.methods = List.of("framed");
        options.rdfXml = genericParts();
        options.frameMode = "custom";
        options.frame = """
                {"@context":{"part":"https://example.org/vocabulary/hasPart"},
                 "@id":"https://example.org/root", "@embed":"@never",
                 "part":{"@embed":"@always"}}
                """;
        ConversionResponse framed = service.convert(options.request());
        assertTrue(framed.errors().isEmpty(), () -> framed.errors().toString());
        ConversionResult result = successful(framed, "framed");
        JsonValue document = jsonValue(content(result));
        assertFalse(hasKey(document, "@context"));
        JsonObject root = findById(document, PART_ROOT);
        assertNotNull(root);
        JsonObject part = root.getJsonArray(EX + "hasPart").getJsonObject(0);
        assertEquals(PART, part.getString("@id"));
        assertTrue(part.containsKey(EX + "label"));
        assertTrue(jsonObject(framed.effectiveFrame()).getJsonObject("@context").containsKey("part"));

        options.frame = options.frame.replace(PART_ROOT, "https://example.org/no-match");
        assertTrue(successful(service.convert(options.request()), "framed").empty());
    }

    @Test
    void invalidRepresentationIsReportedOnlyForJsonLd() throws Exception {
        Options options = new Options(fixture());
        options.representation = "unknown";
        ConversionResponse invalid = service.convert(options.request());
        assertTrue(invalid.results().isEmpty());
        assertTrue(invalid.errors().stream().anyMatch(issue -> issue.field().equals("representation")));
        options.jsonLdOutput = false;
        successful(service.convert(options.request()), "rdfxml");
    }

    @Test
    void producesAllIndependentOutputsAndRoundTripsEveryFullGraphFormat() throws Exception {
        Options options = new Options(fixture());
        options.nQuadsOutput = true;
        options.trigOutput = true;
        options.methods = List.of("expanded", "compacted", "flattened", "framed");
        options.rootIri = ORGANISATION;
        ConversionResponse response = service.convert(options.request());
        assertTrue(response.errors().isEmpty(), () -> response.errors().toString());
        assertEquals(7, response.results().size());
        Map<@NonNull String, ConversionResult> results = byId(response);
        assertEquals(Map.of("rdfxml", "converted.rdf", "expanded", "expanded.jsonld",
                "compacted", "compacted.jsonld", "flattened", "flattened.jsonld", "framed", "framed.jsonld",
                "nquads", "converted.nq", "trig", "converted.trig"),
                results.values().stream().collect(Collectors.toMap(result -> result.id(), result -> result.fileName())));
        Model input = read(fixture(), Lang.RDFXML);
        for (ConversionResult result : response.results()) {
            assertNull(result.error(), () -> result.id() + ": " + result.error());
            assertNotNull(result.content());
            assertEquals(content(result).getBytes(StandardCharsets.UTF_8).length, result.sizeBytes());
            assertEquals(switch (result.id()) {
                case "rdfxml" -> "application/rdf+xml";
                case "nquads" -> "application/n-quads";
                case "trig" -> "application/trig";
                default -> "application/ld+json";
            }, result.mediaType());
            if (result.id().equals("rdfxml")) {
                assertNull(result.graphIri());
                assertTrue(input.isIsomorphicWith(read(content(result), Lang.RDFXML)));
            } else {
                assertEquals(successful(response, "nquads").graphIri(), result.graphIri());
                if (result.id().equals("framed")) namedGraph(result).close();
                else assertDatasetGraph(fixture(), result);
            }
        }
        input.close();
        assertArchiveMatchesResults(response);
        assertTrue(requireNonNull(response.autoContext()).contains("http://schema.org/"));
        assertFalse(requireNonNull(response.autoContext()).contains("https://schema.org/"));
        assertTrue(response.resources().containsAll(List.of(ORGANISATION, ADDRESS)));
        assertFalse(content(requireNonNull(results.get("expanded"))).contains("\"@context\""));
    }

    @Test
    void zipContainsExactlyTheSuccessfulDocumentsAsUtf8() throws Exception {
        Options options = new Options(fixture());
        options.methods = List.of("expanded", "compacted", "flattened", "framed");
        options.rootIri = ORGANISATION;
        assertArchiveMatchesResults(service.convert(options.request()));

        options.contextMode = "custom";
        options.context = "invalid JSON";
        ConversionResponse partial = service.convert(options.request());
        assertFalse(partial.errors().isEmpty());
        assertArchiveMatchesResults(partial);

        options.jsonLdOutput = false;
        assertNull(service.convert(options.request()).zipBase64(), "One result needs no ZIP");
        assertNull(service.inspect(options.request()).zipBase64(), "A metadata preview has no ZIP");
    }

    @Test
    void compactFlatteningKeepsSeparateNodesAndTheCompleteGraph() throws Exception {
        Options options = new Options(fixture());
        options.methods = List.of("flattened");
        options.representation = "compacted";
        options.contextMode = "custom";
        options.context = CONTEXT;
        ConversionResult result = successful(service.convert(options.request()), "flattened");
        JsonObject json = jsonObject(content(result));
        assertTrue(json.containsKey("@context"));
        assertTrue(jsonGraphNodes(result).size() >= 5);
        assertTrue(read(fixture(), Lang.RDFXML).isIsomorphicWith(namedGraph(result)));
    }

    @Test
    void customContextBaseCannotMakeDownloadsDependOnTheirDirectory() throws Exception {
        Options options = new Options(fixture());
        options.methods = List.of("compacted", "flattened");
        options.representation = "compacted";
        options.contextMode = "custom";
        options.context = "{\"@context\":{\"@base\":\"https://example.org/\",\"schema\":\"http://schema.org/\"}}";
        ConversionResponse response = service.convert(options.request());
        Model input = read(fixture(), Lang.RDFXML);
        for (String id : options.methods) {
            assertTrue(input.isIsomorphicWith(namedGraph(successful(response, id))), id);
        }
    }

    @Test
    void customFrameCanEmbedAnyPropertyWhileKeepingOtherRelationsAsReferences() throws Exception {
        Options options = new Options(genericParts());
        options.methods = List.of("framed");
        options.frameMode = "custom";
        options.frame = """
                {"@id":"https://example.org/root", "@embed":"@never",
                 "https://example.org/vocabulary/hasPart":{"@embed":"@always"}}
                """;
        ConversionResponse response = assertTimeoutPreemptively(requireNonNull(Duration.ofSeconds(10)),
                () -> service.convert(options.request()));
        JsonObject root = findById(jsonObject(content(successful(response, "framed"))), PART_ROOT);
        assertNotNull(root);
        JsonValue value = root.get("ex:hasPart");
        if (value instanceof jakarta.json.JsonArray array) value = array.getFirst();
        assertInstanceOf(JsonObject.class, value);
        JsonObject part = (JsonObject) value;
        assertEquals(PART, part.getString("@id"));
        assertEquals("Teil", part.getString("ex:label"));
        JsonValue reference = root.get("ex:related");
        if (reference instanceof jakarta.json.JsonArray array) reference = array.getFirst();
        assertInstanceOf(JsonObject.class, reference);
        assertEquals(java.util.Set.of("@id"), ((JsonObject) reference).keySet());
        JsonObject frame = jsonObject(response.effectiveFrame());
        assertEquals("@never", frame.getString("@embed"));
        assertEquals("@always", frame.getJsonObject(EX + "hasPart").getString("@embed"));
        Model framed = namedGraph(successful(response, "framed"));
        assertFalse(framed.containsResource(framed.createResource("https://example.org/unrelated")));
        assertTrue(framed.size() < read(genericParts(), Lang.RDFXML).size(), "A selective frame intentionally omits unrelated resources");
    }

    @Test
    void customFrameOwnContextIsIndependentAndNoMatchIsExplicit() throws Exception {
        Options options = new Options(fixture());
        options.methods = List.of("expanded", "compacted", "framed");
        options.contextMode = "custom";
        options.context = "{broken";
        options.frameMode = "custom";
        options.frame = """
                {"@context":{"name":"http://schema.org/name"},
                 "@id":"https://example.org/does-not-exist"}
                """;
        ConversionResponse response = service.convert(options.request());
        successful(response, "expanded");
        successful(response, "rdfxml");
        assertNotNull(byId(response).get("compacted").error());
        ConversionResult framed = successful(response, "framed");
        assertTrue(framed.empty());
        assertTrue(jsonGraphNodes(framed).isEmpty(), "A no-match frame keeps an explicit named empty graph");
        assertTrue(jsonObject(response.effectiveFrame()).getJsonObject("@context").containsKey("name"));
    }

    @Test
    void generatedModeReplacesTheRootFrameContextAndPreservesTheCompleteSelectedRdf() throws Exception {
        String xml = rdf("""
                <rdf:Description rdf:about="https://example.org/root">
                  <ex:label>Objekt</ex:label><ex:related rdf:resource="https://example.org/part"/>
                </rdf:Description>
                <rdf:Description rdf:about="https://example.org/part"><ex:label>Teil</ex:label></rdf:Description>
                """);
        Options options = new Options(xml);
        options.methods = List.of("compacted", "flattened", "framed");
        options.representation = "compacted";
        options.contextMode = "generated";
        options.context = "{broken"; // An obsolete custom-context draft has no effect in this mode.
        options.frameMode = "custom";
        options.frame = """
                {"@context":{"ex":"https://wrong.example/"},
                 "@id":"https://example.org/root","ex:related":{"@embed":"@always"}}
                """;
        ConversionResponse response = service.convert(options.request());
        assertTrue(response.errors().isEmpty(), response.errors().toString());
        JsonObject generated = jsonObject(requireNonNull(response.autoContext())).getJsonObject("@context");
        assertEquals(generated, jsonObject(requireNonNull(response.effectiveFrame())).getJsonObject("@context"));
        assertEquals(EX, generated.getJsonObject("ex").getString("@id"));
        Model expected = read(xml, Lang.RDFXML);
        try {
            for (String format : List.of("compacted", "flattened", "framed")) {
                ConversionResult result = successful(response, format);
                assertEquals(generated, jsonObject(content(result)).getJsonObject("@context"), format);
                Model actual = namedGraph(result);
                try {
                    assertTrue(expected.isIsomorphicWith(actual), format + " keeps the same RDF despite a conflicting frame prefix");
                } finally {
                    actual.close();
                }
            }
        } finally {
            expected.close();
        }
    }

    @Test
    void generatedModeRejectsScopedFrameContextsWithoutFailingIndependentOutputs() throws Exception {
        Options options = new Options(fixture());
        options.methods = List.of("compacted", "framed");
        options.contextMode = "generated";
        options.frameMode = "custom";
        for (String nested : List.of("{\"@context\":{\"ex\":\"https://wrong.example/\"}}",
                "[{\"@context\":{}},{\"@embed\":\"@always\"}]")) {
            options.frame = "{\"http://schema.org/member\":" + nested + "}";
            ConversionResponse response = service.convert(options.request());
            assertTrue(response.errors().stream().anyMatch(issue -> issue.field().equals("frame")
                    && issue.message().contains("@context") && issue.message().contains("automatisch")));
            assertNotNull(byId(response).get("framed").error());
            assertNull(response.effectiveFrame());
            successful(response, "rdfxml");
            successful(response, "compacted");
        }
    }

    @Test
    void noMatchRemainsExplicitWhenTheFrameContextAliasesGraph() throws Exception {
        Options options = new Options(fixture());
        options.methods = List.of("framed");
        options.frameMode = "custom";
        options.frame = """
                {"@context":{"nodes":"@graph","identifier":"@id"},
                 "@id":"https://example.org/does-not-exist"}
                """;
        ConversionResult framed = successful(service.convert(options.request()), "framed");
        assertTrue(jsonGraphNodes(framed).isEmpty());
        assertEquals("@id", jsonObject(content(framed)).getJsonObject("@context").getString("identifier"));
        assertTrue(framed.empty(), "An alias for @graph must not hide a no-match result");
    }

    @Test
    void invalidContextAndFrameOnlyFailTheirDependentResults() throws Exception {
        Options options = new Options(fixture());
        options.methods = List.of("expanded", "compacted", "flattened", "framed");
        options.contextMode = "custom";
        options.context = "{\"name\":\"http://schema.org/name\"}";
        options.frameMode = "custom";
        options.frame = "not json";
        ConversionResponse response = service.convert(options.request());
        assertFalse(response.errors().isEmpty());
        successful(response, "rdfxml");
        successful(response, "expanded");
        successful(response, "flattened");
        assertNotNull(byId(response).get("compacted").error());
        assertNotNull(byId(response).get("framed").error());

        options.context = CONTEXT;
        response = service.convert(options.request());
        successful(response, "compacted");
        assertNotNull(byId(response).get("framed").error());
        options.frame = "{\"@embed\":\"@invalid\"}";
        response = service.convert(options.request());
        successful(response, "rdfxml");
        successful(response, "compacted");
        assertNotNull(byId(response).get("framed").error());
    }

    @Test
    void relativeIrisRequireAnExplicitOrDocumentOrXmlBaseForTextAndUpload() {
        String relative = rdf("<rdf:Description rdf:about=\"organisation\"><ex:link rdf:resource=\"adresse\"/></rdf:Description>");
        Options options = new Options(relative);
        assertBaseError(service.convert(options.request()));
        assertBaseError(service.convert(options.request(), relative.getBytes(StandardCharsets.UTF_8)));
        options.baseIri = "https://example.org/source/";
        assertResolved(service.convert(options.request()), "https://example.org/source/organisation", "https://example.org/source/adresse");
        options.baseIri = null;
        options.documentIri = "https://example.org/source/document.rdf";
        assertResolved(service.convert(options.request()), "https://example.org/source/organisation", "https://example.org/source/adresse");
        options.documentIri = null;
        options.rdfXml = relative.replace("<rdf:RDF ", "<rdf:RDF xml:base=\"https://example.org/xml/\" ");
        assertResolved(service.convert(options.request()), "https://example.org/xml/organisation", "https://example.org/xml/adresse");
        options.rdfXml = rdf("<rdf:Description xml:base=\"nested/\" rdf:about=\"item\"/>");
        assertBaseError(service.convert(options.request()));
    }

    @Test
    void rejectsMalformedRdfXmlDtdAndRemoteContextsWithoutHidingOtherOutputs() throws Exception {
        for (String invalid : List.of("<rdf:RDF>", "<not-rdf/>",
                "<!DOCTYPE rdf:RDF [<!ENTITY external SYSTEM 'file:///etc/passwd'>]>" +
                        rdf("<rdf:Description rdf:about=\"https://example.org/subject\"><ex:text>&external;</ex:text></rdf:Description>"))) {
            ConversionResponse response = service.convert(new Options(invalid).request());
            assertTrue(response.results().isEmpty(), invalid);
            assertTrue(response.errors().stream().anyMatch(issue -> issue.field().equals("rdfXml")), invalid);
        }
        Options options = new Options(fixture());
        options.methods = List.of("expanded", "compacted");
        options.contextMode = "custom";
        options.context = "{\"@context\":\"https://127.0.0.1:1/unavailable-context\"}";
        ConversionResponse response = assertTimeoutPreemptively(requireNonNull(Duration.ofSeconds(10)), () -> service.convert(options.request()));
        successful(response, "rdfxml");
        successful(response, "expanded");
        assertNotNull(byId(response).get("compacted").error());
        assertTrue(byId(response).get("compacted").error().contains("Externe JSON-LD-Kontexte"));
        assertFalse(response.errors().isEmpty());
    }

    @Test
    void rejectsInvalidOutputSelectionsAndInputsOverUploadLimit() {
        Options options = new Options(rdf(""));
        options.rdfXmlOutput = false;
        options.jsonLdOutput = false;
        assertFalse(service.convert(options.request()).errors().isEmpty());
        options.jsonLdOutput = true;
        options.methods = List.of();
        assertFalse(service.convert(options.request()).errors().isEmpty());
        options.rdfXmlOutput = true;
        options.jsonLdOutput = false;
        options.rdfXml = " ".repeat(1024 * 1024 + 1);
        assertFalse(service.convert(options.request()).errors().isEmpty());
    }

    @Test
    void uploadHonoursTheXmlEncodingDeclarationAndWritesUtf8() throws Exception {
        String xml = fixture().replace("encoding=\"UTF-8\"", "encoding=\"ISO-8859-1\"");
        Options options = new Options(null);
        ConversionResponse response = service.convert(options.request(), xml.getBytes(StandardCharsets.ISO_8859_1));
        assertTrue(response.errors().isEmpty(), response.errors().toString());
        ConversionResult result = successful(response, "rdfxml");
        assertTrue(read(fixture(), Lang.RDFXML).isIsomorphicWith(read(content(result), Lang.RDFXML)));
        assertTrue(content(result).contains("Hauptstraße"));
        assertEquals(content(result).getBytes(StandardCharsets.UTF_8).length, result.sizeBytes());
    }

    private static void assertArchiveMatchesResults(ConversionResponse response) throws IOException {
        assertNotNull(response.zipBase64());
        Map<String, byte[]> entries = new HashMap<>();
        try (var zip = new ZipInputStream(new ByteArrayInputStream(Base64.getDecoder().decode(requireNonNull(response.zipBase64()))), StandardCharsets.UTF_8)) {
            for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                assertNull(entries.put(entry.getName(), zip.readAllBytes()), "Archive names must be unique");
            }
        }
        var successful = response.results().stream().filter(result -> result.error() == null).toList();
        assertEquals(successful.size(), entries.size(), "The ZIP excludes failed results");
        for (ConversionResult result : successful) {
            assertArrayEquals(content(result).getBytes(StandardCharsets.UTF_8), entries.get(result.fileName()), result.fileName());
        }
    }

    private static void assertDatasetGraph(String rdfXml, ConversionResult result) {
        String graphIri = requireNonNull(result.graphIri(), "Dataset outputs expose their stable record graph identity");
        String document = content(result);
        boolean nquads = result.id().equals("nquads");
        var dataset = DatasetFactory.createTxnMem();
        Model expected = read(rdfXml, Lang.RDFXML);
        try {
            RDFDataMgr.read(dataset, new StringReader(document), "https://unrelated.invalid/output", datasetLanguage(result));
            assertTrue(dataset.getDefaultModel().isEmpty(), "Every source triple belongs to the record's named graph");
            var names = new ArrayList<String>();
            dataset.listNames().forEachRemaining(names::add);
            assertEquals(expected.isEmpty() ? List.of() : List.of(graphIri), names,
                    "One non-empty record creates exactly one named graph; stores need not retain empty graph declarations");
            assertTrue(dataset.getNamedModel(graphIri).isIsomorphicWith(expected), "The named graph retains every RDF term and blank-node relationship");
            if (nquads) {
                assertEquals(expected.size(), document.lines().count(), "N-Quads has exactly one physical line per quad");
                document.lines().forEach(line -> {
                    AtomicInteger statements = new AtomicInteger();
                    RDFParser.create().source(new StringReader(line)).lang(Lang.NQUADS).parse(new StreamRDFBase() {
                        @Override public void quad(Quad quad) {
                            assertFalse(quad.isDefaultGraph());
                            assertTrue(quad.getGraph().isURI());
                            assertEquals(graphIri, quad.getGraph().getURI());
                            statements.incrementAndGet();
                        }
                    });
                    assertEquals(1, statements.get(), "Every physical dump line is one independently valid named-graph N-Quad");
                });
            } else if (result.id().equals("trig")) {
                assertTrue(document.endsWith("\n"), "Every complete TriG record has a trailing LF");
                assertEquals(1, document.chars().filter(value -> value == '\n').count(), "A complete TriG record occupies exactly one physical line");
                assertFalse(document.contains("\r"), "Literal CR is escaped instead of becoming a physical line separator");
            } else {
                jsonGraphNodes(result);
            }
        } finally {
            expected.close();
            dataset.close();
        }
    }

    private void assertGraphIdentity(Options options, String expected) {
        ConversionResponse response = service.convert(options.request());
        assertTrue(response.errors().isEmpty(), () -> response.errors().toString());
        assertEquals(expected, successful(response, "nquads").graphIri());
        assertEquals(expected, successful(response, "trig").graphIri());
        assertEquals(expected, successful(response, "compacted").graphIri());
    }

    private static Options datasetOptions(String rdfXml) {
        Options options = new Options(rdfXml);
        options.rdfXmlOutput = false;
        options.jsonLdOutput = true;
        options.nQuadsOutput = true;
        options.trigOutput = true;
        return options;
    }

    /** Deliberately reuses rdf:nodeID=part across distinct source documents. */
    private static String ddbSource(String id, @Nullable String recordIri) {
        String object = "https://www.deutsche-digitale-bibliothek.de/item/" + id;
        return rdf("""
                <rdf:Description rdf:about="%s">
                  <rdf:type rdf:resource="http://www.europeana.eu/schemas/edm/ProvidedCHO"/>
                  <ex:part rdf:nodeID="part"/>%s
                </rdf:Description>
                <rdf:Description rdf:nodeID="part"><ex:parent rdf:resource="%s"/><ex:label>Teil</ex:label></rdf:Description>
                """.formatted(object, recordIri == null ? "" : "<ex:record rdf:resource=\"" + recordIri + "\"/>", object));
    }

    private static void assertBaseError(ConversionResponse response) {
        assertTrue(response.results().isEmpty());
        assertTrue(response.errors().stream().anyMatch(issue -> issue.field().equals("baseIri")), response.errors().toString());
    }

    private static void assertResolved(ConversionResponse response, String subject, String object) {
        Model model = read(content(successful(response, "rdfxml")), Lang.RDFXML);
        assertTrue(model.contains(model.createResource(subject), model.createProperty("https://example.org/vocabulary/link"), model.createResource(object)));
    }

    private static ConversionResult successful(ConversionResponse response, String id) {
        ConversionResult result = byId(response).get(id);
        assertNotNull(result, () -> "Missing " + id + ": " + response.errors());
        assertNull(result.error(), () -> id + ": " + result.error());
        assertNotNull(result.content());
        return result;
    }

    private static Map<@NonNull String, ConversionResult> byId(ConversionResponse response) {
        return response.results().stream().collect(Collectors.toMap(result -> result.id(), result -> result));
    }

    /** Requires the document body only in tests that expect successful serialization. */
    private static @NonNull String content(ConversionResult result) {
        return requireNonNull(result.content(), () -> "Missing document content for " + result.id());
    }

    private static Model read(String content, Lang language) {
        Model model = ModelFactory.createDefaultModel();
        RDFDataMgr.read(model, new StringReader(content), "https://unrelated.invalid/downloads/output", language);
        return model;
    }

    /** Parse JSON-LD as a dataset: reading it into a Model could silently hide wrong graph placement. */
    private static Model namedGraph(ConversionResult result) {
        String graphIri = requireNonNull(result.graphIri(), "Every JSON-LD result exposes its record graph IRI");
        jsonGraphNodes(result);
        var dataset = DatasetFactory.createTxnMem();
        try {
            RDFDataMgr.read(dataset, new StringReader(content(result)), "https://unrelated.invalid/downloads/output", Lang.JSONLD11);
            assertTrue(dataset.getDefaultModel().isEmpty(), "JSON-LD places no source data in the default graph");
            var names = new ArrayList<String>();
            dataset.listNames().forEachRemaining(names::add);
            assertTrue(names.isEmpty() || names.equals(List.of(graphIri)), "JSON-LD creates no additional named or anonymous graphs: " + names);
            assertTrue(dataset.asDatasetGraph().stream().allMatch(quad -> quad.getGraph().isURI() && graphIri.equals(quad.getGraph().getURI())),
                    "Every quad belongs to the one named record graph");
            return ModelFactory.createDefaultModel().add(dataset.getNamedModel(graphIri));
        } finally {
            dataset.close();
        }
    }

    private static Lang datasetLanguage(ConversionResult result) {
        return switch (result.id()) {
            case "nquads" -> Lang.NQUADS;
            case "trig" -> Lang.TRIG;
            default -> Lang.JSONLD11;
        };
    }

    /** Expand aliases before checking the semantic wrapper, including empty framed graphs. */
    private static jakarta.json.JsonArray expandedJson(ConversionResult result) {
        try {
            return JsonLd.expand(JsonDocument.of(new StringReader(content(result)))).get();
        } catch (Exception ex) {
            throw new AssertionError("Invalid JSON-LD result: " + result.id(), ex);
        }
    }

    private static jakarta.json.JsonArray jsonGraphNodes(ConversionResult result) {
        var expanded = expandedJson(result);
        assertEquals(1, expanded.size(), "Exactly one named record graph is serialized");
        JsonObject graph = expanded.getJsonObject(0);
        assertEquals(requireNonNull(result.graphIri()), graph.getString("@id"));
        assertEquals(java.util.Set.of("@id", "@graph"), graph.keySet(), "The graph container adds no RDF statements of its own");
        return graph.getJsonArray("@graph");
    }

    private static org.w3c.dom.Document xmlDocument(String xml) throws Exception {
        var factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        return factory.newDocumentBuilder().parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
    }

    private static JsonObject jsonObject(String content) {
        try (var reader = Json.createReader(new StringReader(content))) {
            return reader.readObject();
        }
    }

    private static JsonValue jsonValue(String content) {
        try (var reader = Json.createReader(new StringReader(content))) {
            return reader.readValue();
        }
    }

    private static boolean hasKey(JsonValue value, String key) {
        if (value instanceof JsonObject object) {
            return object.containsKey(key) || object.values().stream().anyMatch(child -> hasKey(child, key));
        }
        return value instanceof jakarta.json.JsonArray array && array.stream().anyMatch(child -> hasKey(child, key));
    }

    private static @Nullable JsonObject findById(JsonValue value, String id) {
        if (value instanceof JsonObject object) {
            if (id.equals(object.getString("@id", null))) return object;
            for (JsonValue child : object.values()) {
                JsonObject found = findById(child, id);
                if (found != null) return found;
            }
        } else if (value instanceof jakarta.json.JsonArray array) {
            for (JsonValue child : array) {
                JsonObject found = findById(child, id);
                if (found != null) return found;
            }
        }
        return null;
    }

    static String fixture() throws IOException {
        try (var input = RdfConversionServiceTest.class.getResourceAsStream("/conversion/organisation.rdf")) {
            assertNotNull(input);
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String rdf(String body) {
        return "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" " +
                "xmlns:ex=\"https://example.org/vocabulary/\">" + body + "</rdf:RDF>";
    }

    private static String genericParts() {
        return rdf("""
                <rdf:Description rdf:about="https://example.org/root">
                  <ex:hasPart rdf:resource="https://example.org/part"/>
                  <ex:related rdf:resource="https://example.org/other"/>
                </rdf:Description>
                <rdf:Description rdf:about="https://example.org/part">
                  <ex:label>Teil</ex:label>
                  <ex:owner rdf:resource="https://example.org/root"/>
                </rdf:Description>
                <rdf:Description rdf:about="https://example.org/other"><ex:label>Nur Verweis</ex:label></rdf:Description>
                <rdf:Description rdf:about="https://example.org/unrelated"><ex:label>Nicht ausgewählt</ex:label></rdf:Description>
                """);
    }

    static final class Options {
        String rdfXml;
        String baseIri;
        String documentIri;
        Boolean rdfXmlOutput = true;
        Boolean jsonLdOutput = true;
        Boolean nQuadsOutput;
        Boolean trigOutput;
        List<@Nullable String> methods = List.of("compacted");
        String contextMode = "auto";
        String context;
        String frameMode = "form";
        String rootIri;
        String embed = "@once";
        String frame;
        String representation;
        String xmlRepresentation;
        String xmlStructure;

        Options(String rdfXml) { this.rdfXml = rdfXml; }

        ConversionRequest request() {
            return new ConversionRequest(rdfXml, baseIri, documentIri, rdfXmlOutput, jsonLdOutput, methods,
                    contextMode, context, frameMode, rootIri, embed, frame, representation, xmlRepresentation, xmlStructure, nQuadsOutput, trigOutput);
        }
    }
}
