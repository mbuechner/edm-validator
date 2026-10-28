package de.ddb.edmvalidator.service;

import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.Statement;
import org.apache.jena.util.SplitIRI;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Adds bounded graph context to a writer failure without changing the model. */
final class RdfXmlWriteDiagnostics {
    private static final int MAX_LENGTH = 4000;
    private static final int MAX_STATEMENTS = 10_000;
    private static final int MAX_EXAMPLES = 4;
    // Jena's IRIException exposes the offending IRI only through its message.
    private static final Pattern BAD_IRI = Pattern.compile("Not an RDF IRI: <([^>\\r\\n]*)>");

    private RdfXmlWriteDiagnostics() {}

    static String describe(Exception failure, Model model) {
        String original = message(failure);
        try {
            Set<String> causes = new LinkedHashSet<>();
            Set<String> badIris = new LinkedHashSet<>();
            Set<Throwable> visited = Collections.newSetFromMap(new IdentityHashMap<>());
            for (Throwable cause = failure; cause != null && visited.size() < 12 && visited.add(cause); cause = cause.getCause()) {
                String detail = message(cause);
                if (causes.size() < 3) causes.add(shorten(detail, causes.isEmpty() ? 1000 : 400));
                var matcher = BAD_IRI.matcher(detail);
                for (int matches = 0; matches < 3 && badIris.size() < 3 && matcher.find(); matches++) badIris.add(matcher.group(1));
            }
            StringBuilder result = new StringBuilder(String.join("\nWeitere Ursache: ", causes));
            if (!badIris.isEmpty()) addGraphContext(result, model, badIris);
            return shorten(result.toString(), MAX_LENGTH);
        } catch (RuntimeException ignored) {
            // Diagnostics must never replace the writer error or prevent other outputs.
            return shorten(original, MAX_LENGTH);
        }
    }

    private static void addGraphContext(StringBuilder result, Model model, Set<String> badIris) {
        List<Match> direct = new ArrayList<>();
        List<Match> derived = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        int count = 0;
        var statements = model.listStatements();
        try {
            while (count < MAX_STATEMENTS && statements.hasNext()) {
                Statement statement = statements.nextStatement();
                count++;
                if (statement.getSubject().isURIResource()) {
                    match(direct, seen, "Subjekt", statement.getSubject().getURI(), statement, badIris);
                }
                String predicate = statement.getPredicate().getURI();
                match(direct, seen, "Prädikat", predicate, statement, badIris);
                if (statement.getObject().isURIResource()) {
                    match(direct, seen, "Objekt", statement.getResource().getURI(), statement, badIris);
                } else if (statement.getObject().isLiteral()) {
                    match(direct, seen, "Literal-Datentyp", statement.getLiteral().getDatatypeURI(), statement, badIris);
                }
                int split = SplitIRI.splitXML(predicate);
                if (split > 0 && split < predicate.length()) {
                    String namespace = predicate.substring(0, split);
                    if (badIris.contains(namespace) && derived.size() < MAX_EXAMPLES && seen.add("Namespace:" + predicate)) {
                        derived.add(new Match("Abgeleiteter XML-Namespace", namespace, statement));
                    }
                }
                if (direct.size() >= MAX_EXAMPLES && derived.size() >= MAX_EXAMPLES) break;
            }
        } finally {
            statements.close();
        }
        Map<String, String> prefixes = model.getNsPrefixMap();
        int examples = 0;
        if (!direct.isEmpty()) {
            result.append("\n\nDirekte Fundstellen der beanstandeten IRI im RDF-Graphen:");
            for (Match match : direct) {
                if (examples++ >= MAX_EXAMPLES) break;
                appendMatch(result, match, prefixes);
            }
        }
        if (!derived.isEmpty() && examples < MAX_EXAMPLES) {
            result.append("\n\nBeim Aufteilen der folgenden Prädikat-IRIs ergibt sich der beanstandete XML-Namespace. Dieser abgeleitete Wert ist von einer vollständigen IRI im RDF-Graphen zu unterscheiden:");
            for (Match match : derived) {
                if (examples++ >= MAX_EXAMPLES) break;
                appendMatch(result, match, prefixes);
            }
            result.append("\nNamespace-Deklaration und daraus gebildete Prädikat-IRI in den Daten prüfen.");
        }
        if (direct.isEmpty() && derived.isEmpty()) {
            result.append("\n\nDie beanstandete IRI konnte in den geprüften RDF-Aussagen oder ihren abgeleiteten Prädikat-Namespaces nicht zugeordnet werden.");
        }
        if (count >= MAX_STATEMENTS) result.append("\nDie Suche wurde auf die ersten ").append(MAX_STATEMENTS).append(" RDF-Aussagen begrenzt.");
    }

    private static void match(List<Match> matches, Set<String> seen, String role, String iri, Statement statement, Set<String> badIris) {
        if (matches.size() < MAX_EXAMPLES && badIris.contains(iri)
                && seen.add(role + ":" + iri + ":" + statement.getPredicate().getURI())) {
            matches.add(new Match(role, iri, statement));
        }
    }

    private static void appendMatch(StringBuilder result, Match match, Map<String, String> prefixes) {
        Statement statement = match.statement();
        String predicate = statement.getPredicate().getURI();
        result.append("\n• ").append(match.role()).append(": <").append(shorten(match.iri(), 400)).append(">")
                .append("\n  Prädikat: <").append(shorten(predicate, 600)).append(">");
        Map.Entry<String, String> best = null;
        for (var entry : prefixes.entrySet()) {
            if (!predicate.startsWith(entry.getValue()) || predicate.length() == entry.getValue().length()) continue;
            if (best == null || entry.getValue().length() > best.getValue().length()
                    || entry.getValue().length() == best.getValue().length() && entry.getKey().compareTo(best.getKey()) < 0) best = entry;
        }
        if (best != null) {
            String local = predicate.substring(best.getValue().length());
            result.append("\n  Namespace-Zuordnung im RDF-Modell: ").append(shorten(best.getKey() + ":" + local, 300))
                    .append("; xmlns").append(best.getKey().isEmpty() ? "" : ":" + shorten(best.getKey(), 100))
                    .append("=\"").append(shorten(best.getValue(), 400)).append('"');
        }
        String subject = statement.getSubject().isURIResource()
                ? "<" + shorten(statement.getSubject().getURI(), 400) + ">"
                : "_:" + shorten(statement.getSubject().getId().getLabelString(), 150) + " (Blank Node)";
        result.append("\n  Beispiel-Subjekt: ").append(subject);
    }

    private static String message(Throwable failure) {
        String message = failure.getMessage();
        return message == null || message.isBlank() ? failure.getClass().getSimpleName() : message;
    }

    private static String shorten(String value, int limit) {
        return value.length() <= limit ? value : value.substring(0, limit - 1) + "…";
    }

    private record Match(String role, String iri, Statement statement) {}
}
