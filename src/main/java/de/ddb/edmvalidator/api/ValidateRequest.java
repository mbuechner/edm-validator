package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;

/** Pasted RDF/XML takes precedence over a DDB URL; its optional document IRI resolves relative identifiers. */
@NullMarked
public record ValidateRequest(
        @Nullable String ddbUri,
        @Nullable String rdfXml,
        @Nullable Boolean europeanaProfile,
        @Nullable String documentIri
) {
    /** Preserves callers that do not supply an explicit document base. */
    public ValidateRequest(@Nullable String ddbUri, @Nullable String rdfXml, @Nullable Boolean europeanaProfile) {
        this(ddbUri, rdfXml, europeanaProfile, null);
    }
}
