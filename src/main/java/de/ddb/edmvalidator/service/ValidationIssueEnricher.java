package de.ddb.edmvalidator.service;

import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.NonNull;
import org.jspecify.annotations.Nullable;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static java.util.Objects.requireNonNull;

/** Normalizes parser messages while preserving optional source locations and original document bytes. */
@Component
public class ValidationIssueEnricher {

    private static final Pattern LINE_COL_PATTERN = Pattern.compile("\\[line:\\s*(\\d+),\\s*col:\\s*(\\d+)\\]\\s*(.*)");

    private static final ErrorHintRule[] ERROR_HINT_RULES = new ErrorHintRule[] {
            new ErrorHintRule(
                    Pattern.compile("Non-whitespace text content between element tags", Pattern.CASE_INSENSITIVE),
                    "Zwischen zwei XML-Tags steht unerwarteter Text; dort sind nur XML-Elemente erlaubt."),
            new ErrorHintRule(
                    Pattern.compile("must be terminated by the matching end-tag", Pattern.CASE_INSENSITIVE),
                    "Ein XML-Element wurde nicht korrekt geschlossen; prüfe das zugehörige End-Tag."),
            new ErrorHintRule(
                    Pattern.compile("Attribute.*must be declared", Pattern.CASE_INSENSITIVE),
                    "Ein Attribut ist in diesem Kontext nicht erlaubt oder falsch deklariert."),
            new ErrorHintRule(
                    Pattern.compile("Content is not allowed in prolog", Pattern.CASE_INSENSITIVE),
                    "Vor dem eigentlichen XML-Dokument steht unerwarteter Inhalt; prüfe Encoding/BOM."),
            new ErrorHintRule(
                    Pattern.compile("undefined prefix|undeclared prefix", Pattern.CASE_INSENSITIVE),
                    "Ein Namespace-Prefix ist nicht deklariert."),
            new ErrorHintRule(
                    Pattern.compile("Not a valid XML name", Pattern.CASE_INSENSITIVE),
                    "Ein Element- oder Attributname ist kein gültiger XML-Name.")
    };

    /** Missing parser details remain absent; a missing message receives a readable fallback. */
    public EnrichedIssue enrichIssue(@Nullable String rawMessage, @Nullable Integer line,
                                     @Nullable Integer column, byte @Nullable [] sourceBytes) {
        String normalized = normalizeMessage(rawMessage);
        Integer finalLine = line;
        Integer finalColumn = column;

        if (finalLine == null || finalColumn == null) {
            LineCol parsedLineCol = extractLineCol(rawMessage);
            if (finalLine == null) {
                finalLine = parsedLineCol.line();
            }
            if (finalColumn == null) {
                finalColumn = parsedLineCol.column();
            }
        }

        String explanation = findExplanation(normalized);
        String lineText = finalLine == null ? null : extractLine(sourceBytes, finalLine);
        return new EnrichedIssue(normalized, explanation, finalLine, finalColumn, lineText);
    }

    /** Extracts Jena's {@code [line: ..., col: ...]} coordinates, or returns empty coordinates. */
    public LineCol extractLineCol(@Nullable String message) {
        if (message == null) {
            return new LineCol(null, null);
        }

        Matcher matcher = LINE_COL_PATTERN.matcher(message);
        if (!matcher.find()) {
            return new LineCol(null, null);
        }

        try {
            Integer line = Integer.parseInt(matcher.group(1));
            Integer column = Integer.parseInt(matcher.group(2));
            return new LineCol(line, column);
        } catch (NumberFormatException ex) {
            return new LineCol(null, null);
        }
    }

    private @Nullable String findExplanation(String parserMessage) {
        for (ErrorHintRule rule : ERROR_HINT_RULES) {
            if (rule.matches(parserMessage)) {
                return rule.explanation();
            }
        }
        return null;
    }

    private @NonNull String normalizeMessage(@Nullable String message) {
        if (message == null || message.isBlank()) {
            return "Unbekannter Parserfehler";
        }
        return requireNonNull(message.replaceAll("\\s+", " ").trim());
    }

    private @Nullable String extractLine(byte @Nullable [] contentBytes, int lineNumber) {
        if (lineNumber < 1 || contentBytes == null || contentBytes.length == 0) {
            return null;
        }

        String[] lines = new String(contentBytes, StandardCharsets.UTF_8).split("\\R", -1);
        if (lineNumber > lines.length) {
            return null;
        }

        String line = lines[lineNumber - 1].trim();
        if (line.length() > 220) {
            return line.substring(0, 220) + "...";
        }
        return line;
    }

    /** A nonblank message and the source details that could actually be recovered. */
    @NullMarked
    public record EnrichedIssue(
            String originalMessage,
            @Nullable String explanation,
            @Nullable Integer line,
            @Nullable Integer column,
            @Nullable String lineSnippet
    ) {
    }

    /** Optional one-based parser coordinates; no coordinate is fabricated when extraction fails. */
    @NullMarked
    public record LineCol(@Nullable Integer line, @Nullable Integer column) {
    }

    private record ErrorHintRule(Pattern pattern, String explanation) {
        boolean matches(@Nullable String message) {
            return message != null && pattern.matcher(message).find();
        }
    }
}
