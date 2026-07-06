package de.ddb.edmvalidator.api;

public record ValidationResultItem(
        String section,
        String engine,
        boolean success,
        String originalMessage,
        String explanation,
        Integer line,
        Integer column,
        String lineSnippet,
        Long metricValue,
        String metricLabel
) {
}
