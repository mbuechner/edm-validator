package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.RdfGraphLink;
import de.ddb.edmvalidator.api.RdfGraphNode;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdf.model.Statement;
import org.apache.jena.rdf.model.StmtIterator;
import org.apache.jena.vocabulary.RDF;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RdfGraphPreviewBuilderTest {
    @Test
    void prioritizesTypesAndResourceEdgesWithoutChangingTheModel() {
        Model model = ModelFactory.createDefaultModel();
        try {
            var root = model.createResource("https://example.org/root");
            for (int index = 0; index < 3_000; index++) root.addLiteral(model.createProperty("urn:text:" + index), "value " + index);
            for (int index = 0; index < 20; index++) root.addProperty(model.createProperty("urn:relation:" + index), model.createResource("urn:target:" + index));
            for (int index = 0; index < 3; index++) root.addProperty(RDF.type, model.createResource("urn:Class" + index));
            long size = model.size();

            var preview = RdfGraphPreviewBuilder.build(model);

            assertEquals(1_200, preview.graphLinks().size());
            assertTrue(preview.graphLinks().subList(0, 3).stream().allMatch(link -> RDF.type.getURI().equals(link.predicateUri())));
            assertTrue(preview.graphLinks().subList(3, 23).stream().allMatch(link -> link.predicateUri().startsWith("urn:relation:")));
            assertTrue(preview.graphLinks().subList(23, 1_200).stream().allMatch(link -> link.predicateUri().startsWith("urn:text:")));
            Set<String> ids = preview.graphNodes().stream().map(RdfGraphNode::id).collect(Collectors.toSet());
            assertTrue(preview.graphLinks().stream().allMatch(link -> ids.contains(link.source()) && ids.contains(link.target())));
            assertEquals(3, preview.graphNodes().stream().filter(node -> node.id().equals(root.getURI())).findFirst().orElseThrow().classes().size());
            assertEquals(size, model.size());
        } finally {
            model.close();
        }
    }

    @Test
    void stopsAfterEnoughHighestPriorityStatementsAndClosesItsOnlyIterator() {
        Model nodes = ModelFactory.createDefaultModel();
        try {
            List<Statement> statements = new ArrayList<>();
            for (int index = 0; index < 10_000; index++) {
                statements.add(nodes.createStatement(nodes.createResource("urn:subject:" + index), RDF.type, nodes.createResource("urn:Class")));
            }
            AtomicInteger consumed = new AtomicInteger();
            StmtIterator iterator = mock(StmtIterator.class);
            when(iterator.hasNext()).thenAnswer(_ -> consumed.get() < statements.size());
            when(iterator.nextStatement()).thenAnswer(_ -> statements.get(consumed.getAndIncrement()));
            Model model = mock(Model.class);
            when(model.isEmpty()).thenReturn(false);
            when(model.listStatements()).thenReturn(iterator);

            var preview = RdfGraphPreviewBuilder.build(model);

            assertEquals(1_200, preview.graphLinks().size());
            assertEquals(1_200, consumed.get(), "The bounded preview never consumes the remaining highest-priority statements");
            verify(model, times(1)).listStatements();
            verify(iterator, times(1)).close();
            verify(iterator, never()).toList();
        } finally {
            nodes.close();
        }
    }

    @Test
    void literalIdentityIncludesLanguageAndDatatypeWhileLabelsKeepOnlyTheExactLexicalValue() {
        Model model = ModelFactory.createDefaultModel();
        try {
            var root = model.createResource("urn:subject");
            var property = model.createProperty("urn:value");
            root.addLiteral(property, "1");
            root.addLiteral(property, model.createLiteral("1", "de"));
            root.addLiteral(property, model.createLiteral("1", "en"));
            root.addLiteral(property, model.createTypedLiteral("1", XSDDatatype.XSDinteger));
            root.addLiteral(property, model.createTypedLiteral("1", XSDDatatype.XSDdecimal));
            String lexical = "https://example.org/path#label\n\"quoted\"\\tail";
            root.addLiteral(property, lexical);

            var preview = RdfGraphPreviewBuilder.build(model);
            var literals = preview.graphNodes().stream().filter(node -> "Literal".equals(node.nodeType())).toList();

            assertEquals(6, literals.size(), "Equal lexical strings with different RDF types or languages must remain separate nodes");
            assertEquals(6, preview.graphLinks().stream().map(RdfGraphLink::target).distinct().count());
            assertEquals(5, literals.stream().filter(node -> "1".equals(node.label())).count());
            assertTrue(literals.stream().anyMatch(node -> lexical.equals(node.label())), "URI-like literal content is not shortened as an IRI");
            assertTrue(literals.stream().anyMatch(node -> node.id().contains("@de")));
            assertTrue(literals.stream().anyMatch(node -> node.id().contains(XSDDatatype.XSDinteger.getURI())));
        } finally {
            model.close();
        }
    }
}
