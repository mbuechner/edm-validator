package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;

/** A local RDF/XML source, with an optional base for its relative resource identifiers. */
@NullMarked
public record GraphRequest(@Nullable String rdfXml, @Nullable String documentIri) {
}
