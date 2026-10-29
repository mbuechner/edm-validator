package de.ddb.edmvalidator.api;

import de.ddb.edmvalidator.service.RdfConversionService;
import jakarta.json.Json;
import jakarta.json.JsonObject;
import org.apache.jena.graph.Node;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFDataMgr;
import org.junit.jupiter.api.Test;
import org.jspecify.annotations.NonNull;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.io.StringReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

import static java.util.Objects.requireNonNull;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Exercises the independent graph endpoint with the real, local-only conversion parser. */
class GraphControllerTest {
    private static final @NonNull Charset UTF_8 = requireNonNull(StandardCharsets.UTF_8);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new GraphController(new RdfConversionService())).build();

    @Test
    void graphPreviewUsesDocumentIriWithoutRunningValidationOrFetchingTheSource() throws Exception {
        String xml = """
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                         xmlns:edm="http://www.europeana.eu/schemas/edm/">
                  <edm:ProvidedCHO rdf:about="record"><edm:isShownAt rdf:resource="view"/></edm:ProvidedCHO>
                </rdf:RDF>
                """;
        String request = Json.createObjectBuilder().add("rdfXml", xml)
                .add("documentIri", "https://example.org/source/").build().toString();
        JsonObject response = response(request, 200);
        assertThat(response.isNull("error")).isTrue();
        assertThat(response.getJsonArray("graphNodes").getValuesAs(JsonObject.class))
                .extracting(node -> node.getString("id"))
                .contains("https://example.org/source/record", "https://example.org/source/view",
                        "http://www.europeana.eu/schemas/edm/ProvidedCHO");
        assertThat(response.getJsonArray("graphLinks")).hasSize(2);
        assertThat(response.containsKey("results")).isFalse();
    }

    @Test
    void independentGraphApiParsesTheRealDdbFixtureAndKeepsItsDistinctLiteralValues() throws Exception {
        String xml;
        try (var fixture = requireNonNull(getClass().getResourceAsStream(
                "/examples/BFWBGBQ5ZQ35QZ2NKUIF4AF562ZVFYHS.rdf.xml"))) {
            xml = new String(fixture.readAllBytes(), UTF_8);
        }
        String documentIri = "https://api.deutsche-digitale-bibliothek.de/2/items/BFWBGBQ5ZQ35QZ2NKUIF4AF562ZVFYHS/edm";
        // Only the source text and parser base are passed; this controller has no download service.
        JsonObject response = response(Json.createObjectBuilder().add("rdfXml", xml)
                .add("documentIri", documentIri).build().toString(), 200);
        var nodes = response.getJsonArray("graphNodes").getValuesAs(JsonObject.class);

        assertThat(response.isNull("error")).isTrue();
        assertThat(response.getJsonArray("graphLinks")).isNotEmpty().hasSizeLessThanOrEqualTo(1_200);
        assertThat(nodes).extracting(node -> node.getString("id")).doesNotHaveDuplicates();
        var literals = nodes.stream().filter(node -> "Literal".equals(node.getString("nodeType"))).toList();
        assertThat(literals).isNotEmpty();

        var model = ModelFactory.createDefaultModel();
        try {
            RDFDataMgr.read(model, new StringReader(xml), documentIri, Lang.RDFXML);
            assertThat(model.size()).isLessThanOrEqualTo(1_200);
            Set<Node> expectedLiterals = new HashSet<>();
            var objects = model.listObjects();
            try {
                objects.forEachRemaining(node -> {
                    if (node.isLiteral()) expectedLiterals.add(node.asNode());
                });
            } finally {
                objects.close();
            }
            assertThat(literals).hasSize(expectedLiterals.size());
        } finally {
            model.close();
        }
    }

    @Test
    void missingMalformedAndExternalEntityInputsReturnStructuredErrorsWithoutPartialGraphs() throws Exception {
        for (String xml : new String[]{"", "<rdf:RDF>", """
                <!DOCTYPE rdf:RDF [<!ENTITY external SYSTEM "https://example.org/private">]>
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>
                """}) {
            JsonObject body = response(Json.createObjectBuilder().add("rdfXml", xml).build().toString(), 400);
            assertThat(body.getJsonArray("graphNodes")).isEmpty();
            assertThat(body.getJsonArray("graphLinks")).isEmpty();
            assertThat(body.getString("error")).isNotBlank();
        }
    }

    @Test
    void previewUsesTheSameSizeAndBaseIriRulesAsConversion() throws Exception {
        JsonObject tooLarge = response(Json.createObjectBuilder()
                .add("rdfXml", "x".repeat(RdfConversionService.MAX_INPUT_BYTES + 1)).build().toString(), 400);
        assertThat(tooLarge.getString("error")).contains("1 MiB");
        JsonObject invalidBase = response(Json.createObjectBuilder().add("rdfXml", "<rdf:RDF/>")
                .add("documentIri", "relative/base").build().toString(), 400);
        assertThat(invalidBase.getString("error")).contains("Dokument-IRI");
    }

    private JsonObject response(String request, int expectedStatus) throws Exception {
        String body = mvc.perform(requireNonNull(post("/api/graph").contentType(MediaType.APPLICATION_JSON).content(request)))
                .andExpect(status().is(expectedStatus)).andReturn().getResponse().getContentAsString(UTF_8);
        try (var reader = Json.createReader(new StringReader(body))) {
            return reader.readObject();
        }
    }
}
