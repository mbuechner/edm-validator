package de.ddb.edmvalidator.api;

import java.util.List;

public record ValidationResponse(
        String inputUrl,
        String apiUrl,
        boolean patternValid,
        boolean downloadSuccessful,
        boolean xmlSyntaxPassed,
        boolean rdfSyntaxPassed,
        boolean shaclPassed,
        boolean overallPassed,
        String rdfXml,
        List<RdfGraphNode> graphNodes,
        List<RdfGraphLink> graphLinks,
        List<ValidationResultItem> results,
        String message,
        String error
) {
}
