package de.ddb.edmvalidator.service;

import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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

    public EnrichedIssue enrichIssue(String rawMessage, Integer line, Integer column, byte[] sourceBytes) {
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

    public LineCol extractLineCol(String message) {
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

    private String findExplanation(String parserMessage) {
        for (ErrorHintRule rule : ERROR_HINT_RULES) {
            if (rule.matches(parserMessage)) {
                return rule.explanation();
            }
        }
        return null;
    }

    private String normalizeMessage(String message) {
        if (message == null || message.isBlank()) {
            return "Unbekannter Parserfehler";
        }
        return message.replaceAll("\\s+", " ").trim();
    }

    private String extractLine(byte[] contentBytes, int lineNumber) {
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

    public record EnrichedIssue(
            String originalMessage,
            String explanation,
            Integer line,
            Integer column,
            String lineSnippet
    ) {
    }

    public record LineCol(Integer line, Integer column) {
    }

    private record ErrorHintRule(Pattern pattern, String explanation) {
        boolean matches(String message) {
            return message != null && pattern.matcher(message).find();
        }
    }
}
