package de.ddb.edmvalidator.service;

import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mockStatic;

/** Verifies ownership of models created by successful, empty and interrupted parses. */
class JenaValidationEngineTest {
    private final ValidationIssueEnricher enricher = new ValidationIssueEnricher();
    private final JenaValidationEngine engine = new JenaValidationEngine(new ValidationItemFactory(enricher), enricher);

    @Test
    void successfulParseKeepsTheModelOpenUntilItsOwnerClosesTheOutcome() {
        byte[] bytes = """
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="https://example.org/">
                  <rdf:Description rdf:about="https://example.org/item"><ex:title>Example</ex:title></rdf:Description>
                </rdf:RDF>
                """.getBytes(StandardCharsets.UTF_8);
        Model model;
        try (var parsed = engine.parseRdfSyntax(bytes)) {
            assertTrue(parsed.result().success());
            model = parsed.model();
            assertNotNull(model);
            assertFalse(model.isClosed());
            assertEquals(1, model.size());
        }
        assertTrue(model.isClosed());
    }

    @Test
    void emptyAndPartiallyParsedFailuresCloseTheirUnreturnedModels() {
        for (String xml : new String[]{
                "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>",
                """
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="https://example.org/">
                  <rdf:Description rdf:about="https://example.org/item"><ex:title>Example</ex:title></rdf:Description>
                """}) {
            Model model = ModelFactory.createDefaultModel();
            try (var factory = mockStatic(ModelFactory.class, CALLS_REAL_METHODS)) {
                factory.when(ModelFactory::createDefaultModel).thenReturn(model);
                try (var parsed = engine.parseRdfSyntax(xml.getBytes(StandardCharsets.UTF_8))) {
                    assertFalse(parsed.result().success());
                    assertNull(parsed.model(), "Failed and empty parses transfer no model to the caller");
                    assertTrue(model.isClosed(), "The parser must release every model it cannot return");
                }
            } finally {
                if (!model.isClosed()) model.close();
            }
        }
    }
}
