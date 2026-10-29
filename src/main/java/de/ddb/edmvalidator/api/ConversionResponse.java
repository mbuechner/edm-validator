package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NonNull;
import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;

import java.util.List;

/**
 * Conversion results and independent field errors; collection fields are always present.
 * Metadata is absent when parsing fails, and the ZIP is present only for multiple successful outputs.
 */
@NullMarked
public record ConversionResponse(
        List<ConversionResult> results,
        List<@NonNull ConversionIssue> errors,
        @Nullable String autoContext,
        @Nullable String effectiveFrame,
        List<String> resources,
        @Nullable String zipBase64
) {
}
