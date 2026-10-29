package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;

/** A directed graph edge with a display label and the complete predicate IRI. */
@NullMarked
public record RdfGraphLink(
        String source,
        String target,
        String predicate,
        String predicateUri
) {
}
