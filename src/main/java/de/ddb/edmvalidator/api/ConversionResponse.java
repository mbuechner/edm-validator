package de.ddb.edmvalidator.api;

import java.util.List;

public record ConversionResponse(
        List<ConversionResult> results,
        List<ConversionIssue> errors,
        String autoContext,
        String effectiveFrame,
        List<String> resources,
        String zipBase64
) {
}
