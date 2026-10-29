package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;

/** Requests a DDB document once, before independent tools operate on its editable RDF/XML. */
@NullMarked
public record RdfSourceRequest(@Nullable String ddbUri, @Nullable Boolean europeanaProfile) {
}
