package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.ValidationResultItem;
import lombok.RequiredArgsConstructor;
import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;
import org.springframework.stereotype.Component;

/** Produces consistent engine results and enriches failures without inventing source locations. */
@Component
@RequiredArgsConstructor
@NullMarked
public class ValidationItemFactory {

    private final ValidationIssueEnricher issueEnricher;

    /** Creates a passing result with an optional engine-specific metric. */
    public ValidationResultItem success(String section, String engine, String message,
                                        @Nullable Long metricValue, @Nullable String metricLabel) {
        return new ValidationResultItem(section, engine, true, message, null, null, null, null, metricValue, metricLabel);
    }

    /** Creates a failure, recovering an optional location and excerpt from available parser information. */
    public ValidationResultItem failure(String section, String engine, @Nullable String originalMessage,
                                        @Nullable Integer line, @Nullable Integer column, byte @Nullable [] sourceBytes) {
        return failure(section, engine, originalMessage, line, column, sourceBytes, null, null);
    }

    /** Creates an enriched failure with an optional metric, such as a SHACL violation count. */
    public ValidationResultItem failure(String section, String engine, @Nullable String originalMessage,
                                        @Nullable Integer line, @Nullable Integer column, byte @Nullable [] sourceBytes,
                                        @Nullable Long metricValue, @Nullable String metricLabel) {
        ValidationIssueEnricher.EnrichedIssue enrichedIssue = issueEnricher.enrichIssue(originalMessage, line, column, sourceBytes);
        return new ValidationResultItem(
                section,
                engine,
                false,
                enrichedIssue.originalMessage(),
                enrichedIssue.explanation(),
                enrichedIssue.line(),
                enrichedIssue.column(),
                enrichedIssue.lineSnippet(),
                metricValue,
                metricLabel
        );
    }
}
