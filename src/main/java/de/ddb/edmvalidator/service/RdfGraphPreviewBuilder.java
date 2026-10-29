package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.GraphResponse;
import de.ddb.edmvalidator.api.RdfGraphLink;
import de.ddb.edmvalidator.api.RdfGraphNode;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.RDFNode;
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.rdf.model.Statement;
import org.apache.jena.riot.out.NodeFmtLib;
import org.apache.jena.vocabulary.RDF;
import org.jspecify.annotations.NonNull;
import org.jspecify.annotations.Nullable;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Shared projection for validation and the independent graph tool; never parses or modifies RDF. */
final class RdfGraphPreviewBuilder {
    private static final int MAX_GRAPH_TRIPLES = 1200;

    private RdfGraphPreviewBuilder() {
    }

    /**
     * Builds a bounded graph preview, prioritizing RDF types and resource relationships
     * so numerous literal values cannot crowd the graph's structure out of the preview.
     */
    static @NonNull GraphResponse build(@Nullable Model model) {
        if (model == null || model.isEmpty()) {
            return new GraphResponse(Objects.requireNonNull(List.of()), Objects.requireNonNull(List.of()), null);
        }

        List<Statement> previewStatements = selectStatements(model);
        Map<String, List<String>> classHints = buildClassHints(previewStatements);
        Map<String, RdfGraphNode> nodes = new LinkedHashMap<>();
        List<RdfGraphLink> links = new ArrayList<>();

        for (Statement statement : previewStatements) {
            String sourceId = nodeId(statement.getSubject());
            String targetId = nodeId(statement.getObject());
            String predicateUri = Objects.requireNonNull(statement.getPredicate().getURI(),
                    "An RDF predicate must have an IRI");

            nodes.computeIfAbsent(sourceId, _ -> toGraphNode(statement.getSubject(), sourceId, classHints));
            nodes.computeIfAbsent(targetId, _ -> toGraphNode(statement.getObject(), targetId, classHints));
            links.add(new RdfGraphLink(
                    sourceId,
                    targetId,
                    shortLabel(predicateUri),
                    predicateUri
            ));
        }

        return new GraphResponse(new ArrayList<>(nodes.values()), links, null);
    }

    /** Retains at most three preview-sized buckets, without materializing or sorting the model. */
    private static List<Statement> selectStatements(Model model) {
        List<Statement> types = new ArrayList<>();
        List<Statement> relationships = new ArrayList<>();
        List<Statement> values = new ArrayList<>();
        var statements = model.listStatements();
        try {
            while (types.size() < MAX_GRAPH_TRIPLES && statements.hasNext()) {
                Statement statement = statements.nextStatement();
                List<Statement> bucket = switch (graphStatementPriority(statement)) {
                    case 0 -> types;
                    case 1 -> relationships;
                    default -> values;
                };
                if (bucket.size() < MAX_GRAPH_TRIPLES) bucket.add(statement);
            }
        } finally {
            statements.close();
        }
        List<Statement> preview = new ArrayList<>(MAX_GRAPH_TRIPLES);
        for (List<Statement> bucket : List.of(types, relationships, values)) {
            preview.addAll(bucket.subList(0, Math.min(bucket.size(), MAX_GRAPH_TRIPLES - preview.size())));
        }
        return preview;
    }

    private static int graphStatementPriority(Statement statement) {
        if (!statement.getObject().isResource()) {
            return 2;
        }
        return statement.getPredicate().equals(RDF.type) ? 0 : 1;
    }

    private static RdfGraphNode toGraphNode(RDFNode node, String id, Map<String, List<String>> classHints) {
        String type;
        if (node.isLiteral()) {
            type = "Literal";
        } else if (node.isAnon()) {
            type = "BlankNode";
        } else {
            type = "IRI";
        }
        List<String> classes = Objects.requireNonNull(classHints.getOrDefault(id, List.of()));
        String label = node.isLiteral() ? node.asLiteral().getLexicalForm() : shortLabel(id);
        return new RdfGraphNode(id, label, type, classes);
    }

    /** Class metadata describes the same bounded statements shown by the preview. */
    private static Map<String, List<String>> buildClassHints(List<Statement> statements) {
        Map<String, List<String>> classHints = new LinkedHashMap<>();

        for (Statement statement : statements) {
            if (!statement.getPredicate().equals(RDF.type)
                    || !statement.getSubject().isResource()
                    || !statement.getObject().isResource()) {
                continue;
            }

            String subjectId = nodeId(statement.getSubject());
            String classLabel = shortLabel(statement.getObject().asResource().toString());

            List<String> classes = classHints.computeIfAbsent(subjectId, _ -> new ArrayList<>());
            if (!classes.contains(classLabel)) {
                classes.add(classLabel);
            }
        }

        classHints.replaceAll((_, value) -> List.copyOf(value));
        return classHints;
    }

    private static @NonNull String nodeId(RDFNode node) {
        if (node.isLiteral()) {
            return "literal:" + NodeFmtLib.strNT(node.asNode());
        }
        return nodeId(node.asResource());
    }

    private static @NonNull String nodeId(Resource resource) {
        if (resource.isAnon()) {
            return "_:" + resource.getId().getLabelString();
        }
        return Objects.requireNonNull(resource.getURI(), "A non-blank RDF resource must have an IRI");
    }

    private static @NonNull String shortLabel(@Nullable String value) {
        if (value == null || value.isBlank()) {
            return "(leer)";
        }

        int hashPos = value.lastIndexOf('#');
        if (hashPos >= 0 && hashPos < value.length() - 1) {
            return Objects.requireNonNull(value.substring(hashPos + 1));
        }

        int slashPos = value.lastIndexOf('/');
        if (slashPos >= 0 && slashPos < value.length() - 1) {
            return Objects.requireNonNull(value.substring(slashPos + 1));
        }

        if (value.length() > 60) {
            return value.substring(0, 57) + "...";
        }
        return value;
    }

}
