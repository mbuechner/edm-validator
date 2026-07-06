package de.ddb.edmvalidator.api;

import java.util.List;

public record RdfGraphNode(
        String id,
        String label,
        String nodeType,
        List<String> classes
) {
}
