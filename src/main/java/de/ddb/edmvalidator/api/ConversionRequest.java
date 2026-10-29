package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;

import java.util.List;

/**
 * Options shared by pasted text, uploads and metadata inspection.
 * Omitting all output flags selects RDF/XML. Once any output flag is supplied,
 * only flags explicitly set to {@code true} select an output; null and false do not.
 * {@code rdfXml} may be absent for an upload;
 * base/document IRIs are optional when all resource IRIs are already absolute.
 */
@NullMarked
public record ConversionRequest(
        @Nullable String rdfXml,
        @Nullable String baseIri,
        @Nullable String documentIri,
        @Nullable Boolean rdfXmlOutput,
        @Nullable Boolean jsonLdOutput,
        @Nullable List<@Nullable String> methods,
        @Nullable String contextMode,
        @Nullable String context,
        @Nullable String frameMode,
        @Nullable String rootIri,
        @Nullable String embed,
        @Nullable String frame,
        @Nullable String representation,
        @Nullable String xmlRepresentation,
        @Nullable String xmlStructure,
        @Nullable Boolean nQuadsOutput,
        @Nullable Boolean trigOutput
) {
}
