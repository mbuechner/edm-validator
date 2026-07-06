package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.ValidationResultItem;
import org.springframework.stereotype.Component;

@Component
public class ValidationItemFactory {

    private final ValidationIssueEnricher issueEnricher;

    public ValidationItemFactory(ValidationIssueEnricher issueEnricher) {
        this.issueEnricher = issueEnricher;
    }

    public ValidationResultItem success(String section, String engine, String message, Long metricValue, String metricLabel) {
        return new ValidationResultItem(section, engine, true, message, null, null, null, null, metricValue, metricLabel);
    }

    public ValidationResultItem failure(String section, String engine, String originalMessage,
                                        Integer line, Integer column, byte[] sourceBytes) {
        return failure(section, engine, originalMessage, line, column, sourceBytes, null, null);
    }

    public ValidationResultItem failure(String section, String engine, String originalMessage,
                                        Integer line, Integer column, byte[] sourceBytes,
                                        Long metricValue, String metricLabel) {
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
