package de.ddb.edmvalidator.api;

public record ValidateRequest(
        String ddbUri,
        String rdfXml,
        Boolean europeanaProfile
) {
}
