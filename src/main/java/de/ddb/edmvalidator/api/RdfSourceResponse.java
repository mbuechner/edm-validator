package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;

/** The downloaded source is absent on failure; no validation or conversion has been performed. */
@NullMarked
public record RdfSourceResponse(String ddbUri, @Nullable String apiUrl,
                                @Nullable String rdfXml, @Nullable String error) {
}
