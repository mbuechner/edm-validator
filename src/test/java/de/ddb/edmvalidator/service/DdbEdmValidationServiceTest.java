package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.RdfGraphLink;
import de.ddb.edmvalidator.api.RdfGraphNode;
import de.ddb.edmvalidator.api.ValidationResponse;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.vocabulary.RDF;
import org.eclipse.rdf4j.model.impl.LinkedHashModel;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.when;

class DdbEdmValidationServiceTest {

    @Test
    void boundedPreviewKeepsRdfTypesAndResourceRelationshipsAheadOfLiteralValues() {
        Model model = spy(ModelFactory.createDefaultModel());
        Model snapshot = ModelFactory.createDefaultModel();
        try {
            Resource record = model.createResource("https://example.org/record");
            for (int i = 0; i < 1300; i++) {
                record.addLiteral(model.createProperty("https://example.org/text/" + i), "Literal " + i);
            }
            String classIri = "http://www.europeana.eu/schemas/edm/ProvidedCHO";
            String relationIri = "http://www.europeana.eu/schemas/edm/isShownAt";
            model.add(record, RDF.type, model.createResource(classIri));
            model.add(record, model.createProperty(relationIri), model.createResource("https://example.org/view"));
            snapshot.add(model);
            doAnswer(invocation -> {
                assertEquals(1302, model.size());
                assertTrue(model.isIsomorphicWith(snapshot), "Selecting preview statements must not change the RDF model");
                return invocation.callRealMethod();
            }).when(model).close();

            ValidationResponse response = serviceReturning(model).validate(null, "<rdf:RDF/>", false);

            assertEquals(1200, response.graphLinks().size());
            assertEquals(RDF.type.getURI(), response.graphLinks().get(0).predicateUri());
            assertEquals(classIri, response.graphLinks().get(0).target());
            assertEquals(relationIri, response.graphLinks().get(1).predicateUri());
            assertEquals("https://example.org/view", response.graphLinks().get(1).target());

            Set<String> nodeIds = new HashSet<>();
            for (RdfGraphNode node : response.graphNodes()) {
                nodeIds.add(node.id());
                if (node.id().equals(record.getURI())) {
                    assertTrue(node.classes().contains("ProvidedCHO"));
                }
            }
            for (RdfGraphLink link : response.graphLinks()) {
                assertTrue(nodeIds.contains(link.source()), "Every source must appear in the preview");
                assertTrue(nodeIds.contains(link.target()), "Every target must appear in the preview");
            }
            assertTrue(model.isClosed(), "The service releases the parsed model after creating the detached preview");
        } finally {
            try {
                if (!model.isClosed()) model.close();
            } finally {
                snapshot.close();
            }
        }
    }

    @Test
    void closesTheSuccessfulJenaModelWhenALaterEngineUnexpectedlyFails() {
        Model model = ModelFactory.createDefaultModel();
        try {
            model.createResource("https://example.org/item").addProperty(
                    model.createProperty("https://example.org/title"), "Example");
            DdbEdmValidationService service = serviceReturning(model, true);
            assertThrows(IllegalStateException.class, () -> service.validate(null, "<rdf:RDF/>", false));
            assertTrue(model.isClosed(), "A later engine failure must not abandon the earlier parsed model");
        } finally {
            if (!model.isClosed()) model.close();
        }
    }

    /** Isolates graph projection from XML parsing, external schemas and SHACL execution. */
    private DdbEdmValidationService serviceReturning(Model model) {
        return serviceReturning(model, false);
    }

    private DdbEdmValidationService serviceReturning(Model model, boolean failRdf4j) {
        XmlSyntaxValidator xml = mock(XmlSyntaxValidator.class);
        EdmXsdValidator xsd = mock(EdmXsdValidator.class);
        JenaValidationEngine jena = mock(JenaValidationEngine.class);
        Rdf4jValidationEngine rdf4j = mock(Rdf4jValidationEngine.class);
        ValidationItemFactory items = new ValidationItemFactory(new ValidationIssueEnricher());
        long triples = model.size();
        when(xml.validateWellFormed(any())).thenReturn(items.success(ValidationSections.XML, "XML", "OK", null, null));
        when(xsd.validateAgainstEdmXsd(any())).thenReturn(items.success(ValidationSections.EDM_XSD, "XSD", "OK", null, null));
        when(jena.validateRdfXmlGrammar(any())).thenReturn(items.success(ValidationSections.RDF, "Grammar", "OK", null, null));
        when(jena.parseRdfSyntax(any())).thenReturn(new JenaValidationEngine.JenaParseOutcome(
                items.success(ValidationSections.RDF, "Jena", "OK", triples, "Triples"), model));
        when(rdf4j.parseRdfSyntax(any())).thenReturn(new Rdf4jValidationEngine.Rdf4jParseOutcome(
                items.success(ValidationSections.RDF, "RDF4J", "OK", triples, "Statements"), new LinkedHashModel()));
        if (failRdf4j) when(rdf4j.parseRdfSyntax(any())).thenThrow(new IllegalStateException("Unexpected later failure"));
        when(jena.validateShacl(any(), any())).thenReturn(items.success(ValidationSections.SHACL, "Jena SHACL", "OK", 0L, "Violations"));
        when(rdf4j.validateShacl(any(), any())).thenReturn(items.success(ValidationSections.SHACL, "RDF4J SHACL", "OK", 0L, "Violations"));
        return new DdbEdmValidationService(new DdbRdfSourceService(), xml, xsd, jena, rdf4j);
    }
}
