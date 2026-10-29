package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;

import java.util.List;

/**
 * Validation status, per-engine findings and graph preview.
 * {@code apiUrl} is absent for pasted XML; {@code rdfXml} is absent before a successful
 * download, and {@code error} is absent when the complete validation passes.
 */
@NullMarked
public record ValidationResponse(
        String inputUrl,
        @Nullable String apiUrl,
        boolean patternValid,
        boolean downloadSuccessful,
        boolean xmlSyntaxPassed,
        boolean edmXsdPassed,
        boolean rdfSyntaxPassed,
        boolean shaclPassed,
        boolean overallPassed,
        @Nullable String rdfXml,
        List<RdfGraphNode> graphNodes,
        List<RdfGraphLink> graphLinks,
        List<ValidationResultItem> results,
        String message,
        @Nullable String error
) {
}
