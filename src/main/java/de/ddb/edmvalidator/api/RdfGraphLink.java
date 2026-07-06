package de.ddb.edmvalidator.api;

public record RdfGraphLink(
        String source,
        String target,
        String predicate,
        String predicateUri
) {
}
