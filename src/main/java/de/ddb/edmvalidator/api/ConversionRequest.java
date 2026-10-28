package de.ddb.edmvalidator.api;

import java.util.List;

/** Options are shared by pasted text, uploads, and the metadata preview. */
public record ConversionRequest(
        String rdfXml,
        String baseIri,
        String documentIri,
        Boolean rdfXmlOutput,
        Boolean jsonLdOutput,
        List<String> methods,
        String contextMode,
        String context,
        String frameMode,
        String rootIri,
        String embed,
        String frame,
        String representation,
        String xmlRepresentation,
        String xmlStructure
) {
}
