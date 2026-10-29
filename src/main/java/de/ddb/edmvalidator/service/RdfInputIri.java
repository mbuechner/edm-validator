package de.ddb.edmvalidator.service;

import java.net.URI;
import java.util.Objects;

/** Shared syntactic check for local parser bases; an IRI never authorizes a network request. */
final class RdfInputIri {
    private RdfInputIri() {
    }

    static String absolute(String value, boolean forbidFragment) {
        URI iri = URI.create(value.trim());
        if (!iri.isAbsolute() || forbidFragment && iri.getFragment() != null) throw new IllegalArgumentException();
        return Objects.requireNonNull(iri.toString());
    }
}
