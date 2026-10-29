package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;

/**
 * One engine result. Location, source excerpt, explanation and metrics are included
 * only when the engine supplies them; source line and column numbers are one-based.
 */
@NullMarked
public record ValidationResultItem(
        String section,
        String engine,
        boolean success,
        String originalMessage,
        @Nullable String explanation,
        @Nullable Integer line,
        @Nullable Integer column,
        @Nullable String lineSnippet,
        @Nullable Long metricValue,
        @Nullable String metricLabel
) {
}
