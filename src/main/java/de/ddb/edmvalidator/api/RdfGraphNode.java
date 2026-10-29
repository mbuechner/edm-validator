package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;

import java.util.List;

/** A resource or literal in the bounded graph preview, including known RDF type labels. */
@NullMarked
public record RdfGraphNode(
        String id,
        String label,
        String nodeType,
        List<String> classes
) {
}
