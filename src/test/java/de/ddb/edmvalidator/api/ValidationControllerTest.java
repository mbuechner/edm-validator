package de.ddb.edmvalidator.api;

import de.ddb.edmvalidator.service.DdbEdmValidationService;
import de.ddb.edmvalidator.service.DdbRdfSourceService;
import de.ddb.edmvalidator.service.EdmXsdValidator;
import de.ddb.edmvalidator.service.JenaValidationEngine;
import de.ddb.edmvalidator.service.Rdf4jValidationEngine;
import de.ddb.edmvalidator.service.ValidationIssueEnricher;
import de.ddb.edmvalidator.service.ValidationItemFactory;
import de.ddb.edmvalidator.service.ValidationSections;
import de.ddb.edmvalidator.service.XmlSyntaxValidator;
import jakarta.json.Json;
import jakarta.json.JsonObject;
import org.junit.jupiter.api.Test;
import org.jspecify.annotations.NonNull;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.io.StringReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static java.util.Objects.requireNonNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ValidationControllerTest {
    private static final @NonNull Charset UTF_8 = requireNonNull(StandardCharsets.UTF_8);

    @Test
    void explicitDocumentIriReachesBothRdfEnginesAndRejectsInvalidBasesBeforeValidation() throws Exception {
        ValidationIssueEnricher enricher = new ValidationIssueEnricher();
        ValidationItemFactory items = new ValidationItemFactory(enricher);
        XmlSyntaxValidator xml = spy(new XmlSyntaxValidator(items));
        EdmXsdValidator xsd = mock(EdmXsdValidator.class);
        when(xsd.validateAgainstEdmXsd(any())).thenReturn(items.success(ValidationSections.EDM_XSD, "XSD", "OK", null, null));
        JenaValidationEngine jena = spy(new JenaValidationEngine(items, enricher));
        Rdf4jValidationEngine rdf4j = spy(new Rdf4jValidationEngine(items, enricher));
        doReturn(items.success(ValidationSections.SHACL, "Jena", "OK", null, null)).when(jena).validateShacl(any(), any());
        doReturn(items.success(ValidationSections.SHACL, "RDF4J", "OK", null, null)).when(rdf4j).validateShacl(any(), any());
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ValidationController(new DdbEdmValidationService(
                new DdbRdfSourceService(), xml, xsd, jena, rdf4j))).build();
        String source = """
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="https://example.org/">
                  <rdf:Description rdf:about="record"><ex:view rdf:resource="view"/></rdf:Description>
                </rdf:RDF>
                """;
        String base = "https://example.org/shared-source/";
        String request = Json.createObjectBuilder().add("rdfXml", source).add("documentIri", base).build().toString();
        String content = mvc.perform(requireNonNull(post("/api/validate").contentType(MediaType.APPLICATION_JSON).content(request)))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8);
        JsonObject response;
        try (var reader = Json.createReader(new StringReader(content))) {
            response = reader.readObject();
        }
        assertThat(response.getJsonArray("graphNodes").getValuesAs(JsonObject.class))
                .extracting(node -> node.getString("id")).contains(base + "record", base + "view");
        verify(jena).validateRdfXmlGrammar(any(), eq(base));
        verify(jena).parseRdfSyntax(any(), eq(base));
        verify(rdf4j).parseRdfSyntax(any(), eq(base));

        clearInvocations(xml, xsd, jena, rdf4j);
        String invalid = Json.createObjectBuilder().add("rdfXml", source).add("documentIri", "relative/base").build().toString();
        String error = mvc.perform(requireNonNull(post("/api/validate").contentType(MediaType.APPLICATION_JSON).content(invalid)))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8);
        assertThat(error).contains("Dokument-IRI", "absolute IRI");
        verifyNoInteractions(xml, xsd, jena, rdf4j);
        assertThat(new ValidateRequest(null, source, false).documentIri()).isNull();
    }

    @Test
    void pastedRdfWithViolationsStillReturnsAllResultsWhenXsdIsUnavailable() throws Exception {
        ValidationIssueEnricher enricher = new ValidationIssueEnricher();
        ValidationItemFactory items = new ValidationItemFactory(enricher);
        EdmXsdValidator unavailableXsd = new EdmXsdValidator(items) {
            @Override
            public ValidationResultItem validateAgainstEdmXsd(byte[] rdfXmlBytes) {
                return items.failure(ValidationSections.EDM_XSD, "EDM XSD", "EDM-XSD konnte nicht geladen werden: Zeitlimit",
                        null, null, rdfXmlBytes);
            }
        };
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ValidationController(new DdbEdmValidationService(
                new DdbRdfSourceService(), new XmlSyntaxValidator(items), unavailableXsd,
                new JenaValidationEngine(items, enricher), new Rdf4jValidationEngine(items, enricher)))).build();
        String xml = """
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                         xmlns:edm="http://www.europeana.eu/schemas/edm/"
                         xmlns:ex="https://example.org/">
                  <edm:ProvidedCHO rdf:about="https://example.org/item">
                    <ex:unexpected>Invalid property</ex:unexpected>
                  </edm:ProvidedCHO>
                </rdf:RDF>
                """;
        @NonNull String request = requireNonNull(Json.createObjectBuilder().add("rdfXml", xml).build().toString());

        for (int attempt = 0; attempt < 2; attempt++) {
            String content = mvc.perform(requireNonNull(post("/api/validate").contentType(MediaType.APPLICATION_JSON).content(request)))
                    .andExpect(status().isOk()).andReturn().getResponse().getContentAsString(UTF_8);
            JsonObject response;
            try (var reader = Json.createReader(new StringReader(content))) {
                response = reader.readObject();
            }
            assertThat(response.getString("rdfXml")).isEqualTo(xml);
            assertThat(response.getBoolean("rdfSyntaxPassed")).isTrue();
            assertThat(response.getBoolean("edmXsdPassed")).isFalse();
            assertThat(response.getBoolean("shaclPassed")).isFalse();
            assertThat(response.getJsonArray("results")).hasSize(7);
            JsonObject rdf4j = null;
            for (JsonObject item : response.getJsonArray("results").getValuesAs(JsonObject.class)) {
                if (item.getString("engine").equals("RDF4J SHACL")) {
                    rdf4j = item;
                    break;
                }
            }
            assertNotNull(rdf4j, "RDF4J must return a SHACL result");
            assertThat(rdf4j.getBoolean("success")).isFalse();
            assertThat(rdf4j.getJsonNumber("metricValue").longValue()).isPositive();
            assertThat(rdf4j.getString("originalMessage")).contains("https://example.org/unexpected");
        }
    }
}
