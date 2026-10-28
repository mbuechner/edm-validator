package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.ConversionRequest;
import de.ddb.edmvalidator.api.ConversionResponse;
import de.ddb.edmvalidator.api.ConversionResult;
import jakarta.json.Json;
import jakarta.json.JsonObject;
import jakarta.json.JsonValue;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFDataMgr;
import org.junit.jupiter.api.Test;
import org.w3c.dom.Element;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.*;

class RdfConversionServiceTest {
    private static final String ORGANISATION = "https://example.org/organisation";
    private static final String ADDRESS = "https://example.org/adresse";
    private static final String VCARD = "http://www.w3.org/2006/vcard/ns#";
    private static final String EX = "https://example.org/vocabulary/";
    private static final String PART_ROOT = "https://example.org/root";
    private static final String PART = "https://example.org/part";
    private static final String CONTEXT = """
            {"@context": {
              "schema": {"@id": "http://schema.org/", "@prefix": true},
              "vcard": {"@id": "http://www.w3.org/2006/vcard/ns#", "@prefix": true}
            }}
            """;
    private final RdfConversionService service = new RdfConversionService();

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
                ConversionResponse response = assertTimeoutPreemptively(Duration.ofSeconds(10), () -> service.convert(options.request()));
                assertTrue(response.errors().isEmpty(), response.errors().toString());
                ConversionResult result = successful(response, "rdfxml");
                assertEquals("converted.rdf", result.fileName());
                assertEquals("application/rdf+xml", result.mediaType());
                assertEquals(result.content().getBytes(StandardCharsets.UTF_8).length, result.sizeBytes());
                Model output = read(result.content(), Lang.RDFXML);
                assertTrue(input.isIsomorphicWith(output), representation + " / " + structure);
                assertTrue(result.content().lines().anyMatch(line -> line.startsWith("  <")), "Every XML output is indented");
                for (String property : List.of("raw", "xml")) {
                    assertEquals(input.getProperty(input.createResource("https://example.org/whitespace"), input.createProperty(EX + property)).getLiteral().getLexicalForm(),
                            output.getProperty(output.createResource("https://example.org/whitespace"), output.createProperty(EX + property)).getLiteral().getLexicalForm(), property);
                }
                var document = xmlDocument(result.content());
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
        String output = successful(service.convert(options.request()), "rdfxml").content();
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
        String defaultXml = successful(service.convert(options.request()), "rdfxml").content();
        options.xmlRepresentation = "explicit";
        options.xmlStructure = "flat";
        String indented = successful(service.convert(options.request()), "rdfxml").content();
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
                assertTrue(read(xml, Lang.RDFXML).isIsomorphicWith(read(json.content(), Lang.JSONLD11)),
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
                ConversionResponse response = assertTimeoutPreemptively(Duration.ofSeconds(20),
                        () -> service.convert(options.request()));
                assertTrue(response.errors().isEmpty(), () -> response.errors().toString());
                assertEquals(1, response.results().size());
                ConversionResult result = successful(response, method);
                assertTrue(result.content().lines().anyMatch(line -> line.startsWith(" ")), "Every JSON-LD output is formatted");
                assertEquals(structure.equals("standard") ? representation + ".jsonld"
                        : structure + "-" + representation + ".jsonld", result.fileName());
                JsonValue document = jsonValue(result.content());
                assertEquals(representation.equals("compacted"), hasKey(document, "@context"));
                Model output = read(result.content(), Lang.JSONLD11);
                if (!structure.equals("framed")) {
                    assertTrue(input.isIsomorphicWith(output), structure + " / " + representation);
                    if (structure.equals("flattened")) {
                        var nodes = representation.equals("compacted")
                                ? ((JsonObject) document).getJsonArray("@graph") : (jakarta.json.JsonArray) document;
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
        JsonValue document = jsonValue(result.content());
        assertFalse(hasKey(document, "@context"));
        JsonObject root = findById(document, PART_ROOT);
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
    void producesFiveIndependentOutputsAndRoundTripsEveryFullGraphFormat() throws Exception {
        Options options = new Options(fixture());
        options.methods = List.of("expanded", "compacted", "flattened", "framed");
        options.rootIri = ORGANISATION;
        ConversionResponse response = service.convert(options.request());
        assertTrue(response.errors().isEmpty(), () -> response.errors().toString());
        assertEquals(5, response.results().size());
        Map<String, ConversionResult> results = byId(response);
        assertEquals(Map.of("rdfxml", "converted.rdf", "expanded", "expanded.jsonld",
                "compacted", "compacted.jsonld", "flattened", "flattened.jsonld", "framed", "framed.jsonld"),
                results.values().stream().collect(Collectors.toMap(ConversionResult::id, ConversionResult::fileName)));
        Model input = read(fixture(), Lang.RDFXML);
        for (ConversionResult result : response.results()) {
            assertNull(result.error(), () -> result.id() + ": " + result.error());
            assertNotNull(result.content());
            assertEquals(result.content().getBytes(StandardCharsets.UTF_8).length, result.sizeBytes());
            assertEquals(result.id().equals("rdfxml") ? "application/rdf+xml" : "application/ld+json", result.mediaType());
            if (!result.id().equals("framed")) {
                assertTrue(input.isIsomorphicWith(read(result.content(),
                        result.id().equals("rdfxml") ? Lang.RDFXML : Lang.JSONLD11)), result.id());
            }
        }
        assertTrue(response.autoContext().contains("http://schema.org/"));
        assertFalse(response.autoContext().contains("https://schema.org/"));
        assertTrue(response.resources().containsAll(List.of(ORGANISATION, ADDRESS)));
        assertFalse(results.get("expanded").content().contains("\"@context\""));
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
        JsonObject json = jsonObject(result.content());
        assertTrue(json.containsKey("@context"));
        assertTrue(json.getJsonArray("@graph").size() >= 5);
        assertTrue(read(fixture(), Lang.RDFXML).isIsomorphicWith(read(result.content(), Lang.JSONLD11)));
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
            assertTrue(input.isIsomorphicWith(read(successful(response, id).content(), Lang.JSONLD11)), id);
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
        ConversionResponse response = assertTimeoutPreemptively(Duration.ofSeconds(10),
                () -> service.convert(options.request()));
        JsonObject root = findById(jsonObject(successful(response, "framed").content()), PART_ROOT);
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
        Model framed = read(successful(response, "framed").content(), Lang.JSONLD11);
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
        assertTrue(jsonObject(response.effectiveFrame()).getJsonObject("@context").containsKey("name"));
    }

    @Test
    void noMatchRemainsExplicitWhenTheFrameContextAliasesGraph() throws Exception {
        Options options = new Options(fixture());
        options.methods = List.of("framed");
        options.frameMode = "custom";
        options.frame = """
                {"@context":{"nodes":"@graph"},
                 "@id":"https://example.org/does-not-exist"}
                """;
        ConversionResult framed = successful(service.convert(options.request()), "framed");
        assertTrue(jsonObject(framed.content()).getJsonArray("nodes").isEmpty());
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
        ConversionResponse response = assertTimeoutPreemptively(Duration.ofSeconds(10), () -> service.convert(options.request()));
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
        assertTrue(read(fixture(), Lang.RDFXML).isIsomorphicWith(read(result.content(), Lang.RDFXML)));
        assertTrue(result.content().contains("Hauptstraße"));
        assertEquals(result.content().getBytes(StandardCharsets.UTF_8).length, result.sizeBytes());
    }

    private static void assertArchiveMatchesResults(ConversionResponse response) throws IOException {
        assertNotNull(response.zipBase64());
        Map<String, byte[]> entries = new HashMap<>();
        try (var zip = new ZipInputStream(new ByteArrayInputStream(Base64.getDecoder().decode(response.zipBase64())), StandardCharsets.UTF_8)) {
            for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                assertNull(entries.put(entry.getName(), zip.readAllBytes()), "Archive names must be unique");
            }
        }
        var successful = response.results().stream().filter(result -> result.error() == null).toList();
        assertEquals(successful.size(), entries.size(), "The ZIP excludes failed results");
        for (ConversionResult result : successful) {
            assertArrayEquals(result.content().getBytes(StandardCharsets.UTF_8), entries.get(result.fileName()), result.fileName());
        }
    }

    private static void assertBaseError(ConversionResponse response) {
        assertTrue(response.results().isEmpty());
        assertTrue(response.errors().stream().anyMatch(issue -> issue.field().equals("baseIri")), response.errors().toString());
    }

    private static void assertResolved(ConversionResponse response, String subject, String object) {
        Model model = read(successful(response, "rdfxml").content(), Lang.RDFXML);
        assertTrue(model.contains(model.createResource(subject), model.createProperty("https://example.org/vocabulary/link"), model.createResource(object)));
    }

    private static ConversionResult successful(ConversionResponse response, String id) {
        ConversionResult result = byId(response).get(id);
        assertNotNull(result, () -> "Missing " + id + ": " + response.errors());
        assertNull(result.error(), () -> id + ": " + result.error());
        assertNotNull(result.content());
        return result;
    }

    private static Map<String, ConversionResult> byId(ConversionResponse response) {
        return response.results().stream().collect(Collectors.toMap(ConversionResult::id, result -> result));
    }

    private static Model read(String content, Lang language) {
        Model model = ModelFactory.createDefaultModel();
        RDFDataMgr.read(model, new StringReader(content), "https://unrelated.invalid/downloads/output", language);
        return model;
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

    private static JsonObject findById(JsonValue value, String id) {
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
        List<String> methods = List.of("compacted");
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
                    contextMode, context, frameMode, rootIri, embed, frame, representation, xmlRepresentation, xmlStructure);
        }
    }
}
