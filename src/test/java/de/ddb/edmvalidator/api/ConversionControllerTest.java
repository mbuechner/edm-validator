package de.ddb.edmvalidator.api;

import de.ddb.edmvalidator.service.RdfConversionService;
import jakarta.json.Json;
import jakarta.json.JsonObject;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFDataMgr;
import org.junit.jupiter.api.Test;
import org.jspecify.annotations.NonNull;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.RequestBuilder;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.w3c.dom.Element;
import org.xml.sax.InputSource;
import tools.jackson.databind.json.JsonMapper;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.StringReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;
import static java.util.Objects.requireNonNull;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ConversionControllerTest {
    private static final @NonNull Charset UTF_8 = requireNonNull(StandardCharsets.UTF_8);
    private static final String DDB_ID = "224IOLKFSF3WLN3FUEHIBGIVX3PRYU6I";
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(
            new ConversionController(new RdfConversionService(), requireNonNull(JsonMapper.builder().build()))).build();

    @Test
    void omittedOutputFlagsDefaultToXmlAndTheApiSupportsFourExplicitFormats() throws Exception {
        String xml = """
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="urn:example:">
                  <rdf:Description rdf:about="https://www.deutsche-digitale-bibliothek.de/item/%s">
                    <rdf:type rdf:resource="http://www.europeana.eu/schemas/edm/ProvidedCHO"/>
                    <ex:record rdf:resource="https://api.deutsche-digitale-bibliothek.de/records/%s"/>
                    <ex:name>Sammlung</ex:name>
                  </rdf:Description>
                </rdf:RDF>
                """.formatted(DDB_ID, DDB_ID);
        JsonObject defaults = convertRequest(Json.createObjectBuilder().add("rdfXml", xml).build());
        assertEquals(1, defaults.getJsonArray("results").size());
        assertEquals("rdfxml", defaults.getJsonArray("results").getJsonObject(0).getString("id"));
        assertTrue(defaults.isNull("zipBase64"));
        for (String flag : List.of("rdfXmlOutput", "jsonLdOutput", "nQuadsOutput", "trigOutput")) {
            JsonObject body = convertRequest(Json.createObjectBuilder().add("rdfXml", xml).add(flag, true).build());
            assertTrue(body.getJsonArray("errors").isEmpty(), body.toString());
            assertEquals(1, body.getJsonArray("results").size());
            assertEquals(switch (flag) {
                case "rdfXmlOutput" -> "rdfxml";
                case "jsonLdOutput" -> "compacted";
                case "nQuadsOutput" -> "nquads";
                default -> "trig";
            }, body.getJsonArray("results").getJsonObject(0).getString("id"));
            JsonObject result = body.getJsonArray("results").getJsonObject(0);
            if (flag.equals("rdfXmlOutput")) assertTrue(result.isNull("graphIri"));
            else assertEquals("https://api.deutsche-digitale-bibliothek.de/items/" + DDB_ID, result.getString("graphIri"));
        }
        JsonObject none = convertRequest(Json.createObjectBuilder().add("rdfXml", xml)
                .add("rdfXmlOutput", false).add("jsonLdOutput", false).add("nQuadsOutput", false).add("trigOutput", false).build());
        assertTrue(none.getJsonArray("results").isEmpty());
        assertEquals("outputs", none.getJsonArray("errors").getJsonObject(0).getString("field"));
        JsonObject all = convertRequest(Json.createObjectBuilder().add("rdfXml", xml)
                .add("rdfXmlOutput", true).add("jsonLdOutput", true).add("nQuadsOutput", true).add("trigOutput", true).build());
        assertTrue(all.getJsonArray("errors").isEmpty(), all.toString());
        assertEquals(Set.of("rdfxml", "nquads", "trig", "compacted"), all.getJsonArray("results").getValuesAs(JsonObject.class)
                .stream().map(result -> result.getString("id")).collect(Collectors.toSet()));
        assertFalse(all.isNull("zipBase64"));
    }

    @Test
    void datasetTextAndEncodedUploadsExposeUtf8NamedGraphsWithSourceByteIdentities() throws Exception {
        String xml = """
                <?xml version="1.0" encoding="UTF-8"?>
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="urn:example:">
                  <rdf:Description rdf:about="https://example.org/record"><ex:name xml:lang="de">München &amp; Straße</ex:name>
                    <ex:part rdf:nodeID="part"/></rdf:Description>
                  <rdf:Description rdf:nodeID="part"><ex:parent rdf:resource="https://example.org/record"/></rdf:Description>
                </rdf:RDF>
                """;
        byte[] encoded = xml.replace("encoding=\"UTF-8\"", "encoding=\"ISO-8859-1\"").getBytes(StandardCharsets.ISO_8859_1);
        MockMultipartFile file = new MockMultipartFile("file", "record.rdf", "application/rdf+xml", encoded);
        for (String format : List.of("nquads", "trig", "compacted")) {
            String flag = switch (format) {
                case "nquads" -> "nQuadsOutput";
                case "trig" -> "trigOutput";
                default -> "jsonLdOutput";
            };
            JsonObject options = Json.createObjectBuilder().add(flag, true).build();
            JsonObject text = convertRequest(Json.createObjectBuilder(options).add("rdfXml", xml).build());
            JsonObject upload = response(perform(multipart("/api/convert/upload").file(file).param("options", options.toString()))
                    .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8));
            List<JsonObject> bodies = List.of(text, upload);
            List<byte[]> sources = List.of(xml.getBytes(StandardCharsets.UTF_8), encoded);
            for (int index = 0; index < bodies.size(); index++) {
                JsonObject body = bodies.get(index);
                assertTrue(body.getJsonArray("errors").isEmpty(), body.toString());
                assertEquals(1, body.getJsonArray("results").size());
                JsonObject result = body.getJsonArray("results").getJsonObject(0);
                assertEquals(format, result.getString("id"));
                assertEquals(switch (format) {
                    case "nquads" -> "converted.nq";
                    case "trig" -> "converted.trig";
                    default -> "compacted.jsonld";
                }, result.getString("fileName"));
                assertEquals(switch (format) {
                    case "nquads" -> "application/n-quads";
                    case "trig" -> "application/trig";
                    default -> "application/ld+json";
                }, result.getString("mediaType"));
                String graphIri = "urn:sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(sources.get(index)));
                assertEquals(graphIri, result.getString("graphIri"), "Fallback identity uses the original text/upload bytes");
                assertFalse(result.getBoolean("empty"));
                String content = result.getString("content");
                assertTrue(content.contains("München & Straße"));
                assertEquals(content.getBytes(StandardCharsets.UTF_8).length, result.getJsonNumber("sizeBytes").longValue());
                assertTrue(body.isNull("zipBase64"));
                if (format.equals("trig")) {
                    assertTrue(content.endsWith("\n"));
                    assertEquals(1, content.chars().filter(value -> value == '\n').count());
                    assertFalse(content.contains("\r"));
                }
                var dataset = DatasetFactory.createTxnMem();
                Model expected = model(xml);
                try {
                    RDFDataMgr.read(dataset, new StringReader(content), "https://unrelated.invalid/output", switch (format) {
                        case "nquads" -> Lang.NQUADS;
                        case "trig" -> Lang.TRIG;
                        default -> Lang.JSONLD11;
                    });
                    List<String> names = new ArrayList<>();
                    dataset.listNames().forEachRemaining(names::add);
                    assertEquals(List.of(graphIri), names);
                    assertTrue(dataset.getDefaultModel().isEmpty());
                    assertTrue(dataset.getNamedModel(graphIri).isIsomorphicWith(expected));
                } finally {
                    dataset.close();
                    expected.close();
                }
            }
        }
    }

    @Test
    void textAndEverySupportedUploadExtensionProduceTheSameRdfGraph() throws Exception {
        String xml;
        try (var input = getClass().getResourceAsStream("/conversion/organisation.rdf")) {
            assertNotNull(input);
            xml = new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
        @NonNull String textRequest = requireNonNull(Json.createObjectBuilder()
                .add("rdfXml", xml).add("rdfXmlOutput", true).add("jsonLdOutput", false).build().toString());
        JsonObject textResponse = response(perform(post("/api/convert")
                        .contentType(MediaType.APPLICATION_JSON).content(textRequest))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8));
        assertTrue(textResponse.getJsonArray("errors").isEmpty());
        String textResult = textResponse.getJsonArray("results").getJsonObject(0).getString("content");
        assertTrue(model(xml).isIsomorphicWith(model(textResult)));

        for (String extension : new String[]{"rdf", "xml", "owl"}) {
            MockMultipartFile file = new MockMultipartFile("file", "organisation." + extension,
                    "application/rdf+xml", xml.getBytes(StandardCharsets.UTF_8));
            JsonObject uploadResponse = response(perform(multipart("/api/convert/upload").file(file)
                            .param("options", "{\"rdfXmlOutput\":true,\"jsonLdOutput\":false}"))
                    .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8));
            assertTrue(uploadResponse.getJsonArray("errors").isEmpty(), uploadResponse.toString());
            JsonObject result = uploadResponse.getJsonArray("results").getJsonObject(0);
            assertEquals("converted.rdf", result.getString("fileName"));
            assertEquals("application/rdf+xml", result.getString("mediaType"));
            assertTrue(model(xml).isIsomorphicWith(model(result.getString("content"))));
            assertEquals(result.getString("content").getBytes(StandardCharsets.UTF_8).length,
                    result.getJsonNumber("sizeBytes").longValue());
        }
    }

    @Test
    void rdfExtensionDoesNotMakeInvalidUploadedXmlValid() throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", "invalid.rdf", "application/rdf+xml",
                "<rdf:RDF>".getBytes(StandardCharsets.UTF_8));
        JsonObject body = response(perform(multipart("/api/convert/upload").file(file)
                        .param("options", "{}"))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8));
        assertTrue(body.getJsonArray("results").isEmpty());
        assertFalse(body.getJsonArray("errors").isEmpty());
        assertEquals("rdfXml", body.getJsonArray("errors").getJsonObject(0).getString("field"));
    }

    @Test
    void typedFlatXmlIsAcceptedForTextAndUploadsAndPreservesTypedResourcesAtTheTopLevel() throws Exception {
        String xml = """
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                         xmlns:ex="https://example.org/vocabulary/">
                  <ex:Record rdf:about="https://example.org/resource">
                    <ex:label xml:lang="de">Sammlung &amp; Überlieferung</ex:label>
                    <ex:hasPart>
                      <ex:Part rdf:nodeID="part">
                        <ex:label>Ein Teil</ex:label>
                        <ex:parent rdf:resource="https://example.org/resource"/>
                      </ex:Part>
                    </ex:hasPart>
                  </ex:Record>
                </rdf:RDF>
                """;
        String options = Json.createObjectBuilder().add("rdfXmlOutput", true).add("jsonLdOutput", false)
                .add("xmlRepresentation", "typed").add("xmlStructure", "flat").build().toString();
        @NonNull String pasted = requireNonNull(Json.createObjectBuilder().add("rdfXml", xml).add("rdfXmlOutput", true).add("jsonLdOutput", false)
                .add("xmlRepresentation", "typed").add("xmlStructure", "flat").build().toString());
        JsonObject text = response(perform(post("/api/convert").contentType(MediaType.APPLICATION_JSON).content(pasted))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8));
        assertTypedFlatOutput(text, xml);
        MockMultipartFile file = new MockMultipartFile("file", "record.rdf", "application/rdf+xml", xml.getBytes(StandardCharsets.UTF_8));
        JsonObject upload = response(perform(multipart("/api/convert/upload").file(file).param("options", options))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8));
        assertTypedFlatOutput(upload, xml);
    }

    @Test
    void inspectionReturnsOnlyContextAndResourcesWithoutRequiringAnOutputSelection() throws Exception {
        String xml = """
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:schema="http://schema.org/">
                  <rdf:Description rdf:about="https://example.org/resource"><schema:name>Vorschau</schema:name></rdf:Description>
                </rdf:RDF>
                """;
        @NonNull String request = requireNonNull(Json.createObjectBuilder().add("rdfXml", xml)
                .add("rdfXmlOutput", false).add("jsonLdOutput", false).build().toString());
        JsonObject body = response(perform(post("/api/convert/inspect")
                        .contentType(MediaType.APPLICATION_JSON).content(request))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8));
        assertTrue(body.getJsonArray("results").isEmpty());
        assertTrue(body.getJsonArray("errors").isEmpty());
        assertEquals("https://example.org/resource", body.getJsonArray("resources").getString(0));
        assertTrue(response(body.getString("autoContext")).getJsonObject("@context").containsKey("schema"));
    }

    @Test
    void rdfXmlWriterFailureExplainsDerivedNamespacePredicatePrefixAndSubjectForTextAndUpload() throws Exception {
        String xml = """
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                         xmlns:ex="http://example.test">
                  <rdf:Description rdf:about="https://example.org/resource">
                    <ex:label xml:lang="de">Ein gültiges RDF-Literal</ex:label>
                  </rdf:Description>
                </rdf:RDF>
                """;
        String options = Json.createObjectBuilder().add("rdfXmlOutput", true).add("jsonLdOutput", false)
                .add("xmlRepresentation", "explicit").add("xmlStructure", "flat").build().toString();
        @NonNull String pasted = requireNonNull(Json.createObjectBuilder(response(options)).add("rdfXml", xml).build().toString());
        JsonObject text = response(perform(post("/api/convert").contentType(MediaType.APPLICATION_JSON).content(pasted))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8));
        MockMultipartFile file = new MockMultipartFile("file", "namespace.rdf", "application/rdf+xml", xml.getBytes(StandardCharsets.UTF_8));
        JsonObject upload = response(perform(multipart("/api/convert/upload").file(file).param("options", options))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8));
        for (JsonObject body : List.of(text, upload)) {
            assertEquals(1, body.getJsonArray("results").size(), body.toString());
            JsonObject result = body.getJsonArray("results").getJsonObject(0);
            assertEquals("rdfxml", result.getString("id"));
            assertTrue(result.isNull("content"), "A failed serialization exposes no partial document");
            assertEquals(0, result.getJsonNumber("sizeBytes").longValue());
            String error = result.getString("error");
            assertTrue(error.contains("Not an RDF IRI"), error);
            assertTrue(error.contains("http://"), error);
            assertTrue(error.lines().skip(1).anyMatch(line -> line.contains("http://") && !line.contains("http://example.test")),
                    "The derived namespace http:// is explained separately from the original predicate: " + error);
            assertTrue(error.contains("http://example.testlabel"), error);
            assertTrue(error.contains("xmlns:ex"), error);
            assertTrue(error.contains("http://example.test"), error);
            assertTrue(error.contains("https://example.org/resource"), error);
            assertTrue(error.lines().count() >= 5, "The cause and graph diagnostics are returned as separate readable lines");
        }
    }

    @Test
    void malformedUploadOptionsAndOversizedFilesReturnStructuredErrors() throws Exception {
        MockMultipartFile small = new MockMultipartFile("file", "input.rdf", "application/rdf+xml", new byte[]{1});
        for (String options : new String[]{"{broken", "null", "[]", "\"string\"", "{} {}"}) {
            JsonObject invalidOptions = response(perform(multipart("/api/convert/upload").file(small)
                            .param("options", options))
                    .andExpect(status().isBadRequest()).andReturn().getResponse().getContentAsString(UTF_8));
            assertTrue(invalidOptions.getJsonArray("results").isEmpty());
            assertFalse(invalidOptions.getJsonArray("errors").isEmpty());
            assertEquals("outputs", invalidOptions.getJsonArray("errors").getJsonObject(0).getString("field"));
        }

        MockMultipartFile large = new MockMultipartFile("file", "large.rdf", "application/rdf+xml", new byte[1024 * 1024 + 1]);
        JsonObject tooLarge = response(perform(multipart("/api/convert/upload").file(large).param("options", "{}"))
                .andExpect(status().is(413)).andReturn().getResponse().getContentAsString(UTF_8));
        assertTrue(tooLarge.getJsonArray("results").isEmpty());
        JsonObject issue = tooLarge.getJsonArray("errors").getJsonObject(0);
        assertEquals("rdfXml", issue.getString("field"));
        assertTrue(issue.getString("message").contains("1 MiB"));
    }

    /** Checks the non-annotated fluent builder at the Spring API boundary. */
    private @NonNull ResultActions perform(RequestBuilder request) throws Exception {
        return mvc.perform(requireNonNull(request));
    }

    private JsonObject convertRequest(JsonObject request) throws Exception {
        return response(perform(post("/api/convert").contentType(MediaType.APPLICATION_JSON).content(requireNonNull(request.toString())))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8));
    }

    private static JsonObject response(String json) {
        try (var reader = Json.createReader(new StringReader(json))) {
            return reader.readObject();
        }
    }

    private static void assertTypedFlatOutput(JsonObject body, String input) throws Exception {
        assertTrue(body.getJsonArray("errors").isEmpty(), body.toString());
        assertEquals(1, body.getJsonArray("results").size());
        JsonObject result = body.getJsonArray("results").getJsonObject(0);
        assertTrue(result.isNull("error"), result.toString());
        assertEquals("converted.rdf", result.getString("fileName"));
        assertEquals("application/rdf+xml", result.getString("mediaType"));
        String output = result.getString("content");
        assertEquals(output.getBytes(StandardCharsets.UTF_8).length, result.getJsonNumber("sizeBytes").longValue());
        assertTrue(model(input).isIsomorphicWith(model(output)), "Text and multipart options preserve the same RDF graph");
        var factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        Element root = factory.newDocumentBuilder().parse(new InputSource(new StringReader(output))).getDocumentElement();
        assertEquals("http://www.w3.org/1999/02/22-rdf-syntax-ns#", root.getNamespaceURI());
        assertEquals("RDF", root.getLocalName());
        List<Element> resources = new ArrayList<>();
        for (var child = root.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (child instanceof Element element) resources.add(element);
        }
        assertEquals(2, resources.size(), "Both described resources are direct children of rdf:RDF");
        assertTrue(resources.stream().anyMatch(element -> "https://example.org/vocabulary/".equals(element.getNamespaceURI())
                && "Record".equals(element.getLocalName())));
        assertTrue(resources.stream().anyMatch(element -> "https://example.org/vocabulary/".equals(element.getNamespaceURI())
                && "Part".equals(element.getLocalName())));
        for (Element resource : resources) {
            for (var property = resource.getFirstChild(); property != null; property = property.getNextSibling()) {
                for (var child = property.getFirstChild(); child != null; child = child.getNextSibling()) {
                    assertFalse(child instanceof Element, "Resource properties use references instead of nested RDF descriptions");
                }
            }
        }
    }

    private static Model model(String xml) {
        Model model = ModelFactory.createDefaultModel();
        RDFDataMgr.read(model, new StringReader(xml), "https://example.org/", Lang.RDFXML);
        return model;
    }
}
