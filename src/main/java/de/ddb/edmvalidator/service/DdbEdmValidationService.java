package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.RdfGraphLink;
import de.ddb.edmvalidator.api.RdfGraphNode;
import de.ddb.edmvalidator.api.ValidationResponse;
import de.ddb.edmvalidator.api.ValidationResultItem;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.RDFNode;
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.rdf.model.Statement;
import org.apache.jena.vocabulary.RDF;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class DdbEdmValidationService {

    private static final int MAX_GRAPH_TRIPLES = 1200;

    private static final Pattern DDB_ITEM_PATTERN = Pattern.compile(
            DdbConstants.DDB_WEB_ITEM_PATTERN);

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(60))
            .build();

    private final XmlSyntaxValidator xmlSyntaxValidator;
    private final EdmXsdValidator edmXsdValidator;
    private final JenaValidationEngine jenaValidationEngine;
    private final Rdf4jValidationEngine rdf4jValidationEngine;

    public DdbEdmValidationService(XmlSyntaxValidator xmlSyntaxValidator,
                                   EdmXsdValidator edmXsdValidator,
                                   JenaValidationEngine jenaValidationEngine,
                                   Rdf4jValidationEngine rdf4jValidationEngine) {
        this.xmlSyntaxValidator = xmlSyntaxValidator;
        this.edmXsdValidator = edmXsdValidator;
        this.jenaValidationEngine = jenaValidationEngine;
        this.rdf4jValidationEngine = rdf4jValidationEngine;
    }

    public ValidationResponse validate(String inputUrl, String rdfXmlInput, boolean europeanaProfile) {
        if (rdfXmlInput != null && !rdfXmlInput.isBlank()) {
            byte[] rdfXmlBytes = rdfXmlInput.getBytes(StandardCharsets.UTF_8);
            return validateContent(
                    "Lokale RDF/XML-Eingabe",
                    null,
                    true,
                    true,
                    rdfXmlBytes,
                    rdfXmlInput
            );
        }

        List<ValidationResultItem> results = new ArrayList<>();

    String normalizedInput = inputUrl == null ? "" : inputUrl.trim();

    Matcher matcher = DDB_ITEM_PATTERN.matcher(normalizedInput);
        if (!matcher.matches()) {
            return new ValidationResponse(
            normalizedInput,
                    null,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    null,
                    List.of(),
                    List.of(),
                    results,
                    "Ungültige DDB-Item-URL",
                    "Erwartetes Muster: https://www.deutsche-digitale-bibliothek.de/item/{ID}");
        }

        String itemId = matcher.group(1);
        String apiUrl = buildApiUrl(itemId);

        byte[] rdfXmlBytes;
        String rdfXml;
        try {
            rdfXmlBytes = downloadRdfXml(apiUrl, europeanaProfile);
            rdfXml = new String(rdfXmlBytes, StandardCharsets.UTF_8);
        } catch (IllegalStateException ex) {
            return new ValidationResponse(
                    inputUrl,
                    apiUrl,
                    true,
                    false,
                    false,
                    false,
                    false,
                    false,
                    null,
                    List.of(),
                    List.of(),
                    results,
                    "Download fehlgeschlagen",
                    ex.getMessage());
        }

                return validateContent(
                    normalizedInput,
                    apiUrl,
                    true,
                    true,
                    rdfXmlBytes,
                    rdfXml
                );
                }

                private ValidationResponse validateContent(String inputLabel,
                                       String apiUrl,
                                       boolean patternValid,
                                       boolean downloadSuccessful,
                                       byte[] rdfXmlBytes,
                                       String rdfXml) {
                List<ValidationResultItem> results = new ArrayList<>();

        results.add(xmlSyntaxValidator.validateWellFormed(rdfXmlBytes));
        results.add(edmXsdValidator.validateAgainstEdmXsd(rdfXmlBytes));
        results.add(jenaValidationEngine.validateRdfXmlGrammar(rdfXmlBytes));

        JenaValidationEngine.JenaParseOutcome jenaParse = jenaValidationEngine.parseRdfSyntax(rdfXmlBytes);
        results.add(jenaParse.result());

        Rdf4jValidationEngine.Rdf4jParseOutcome rdf4jParse = rdf4jValidationEngine.parseRdfSyntax(rdfXmlBytes);
        results.add(rdf4jParse.result());

        results.add(jenaValidationEngine.validateShacl(jenaParse.model(), rdfXmlBytes));
        results.add(rdf4jValidationEngine.validateShacl(rdf4jParse.model(), rdfXmlBytes));

        GraphPayload graphPayload = buildGraphPayload(jenaParse.model());

        boolean xmlSyntaxPassed = allSucceededInSection(results, ValidationSections.XML);
        boolean rdfSyntaxPassed = allSucceededInSection(results, ValidationSections.RDF);
        boolean shaclPassed = allSucceededInSection(results, ValidationSections.SHACL);
        boolean overallPassed = xmlSyntaxPassed && rdfSyntaxPassed && shaclPassed;

        String message = overallPassed
                ? "Validierung erfolgreich (XML-Syntax, RDF-Syntax, SHACL)"
                : "Validierung mit Befunden abgeschlossen";

        return new ValidationResponse(
            inputLabel,
                apiUrl,
            patternValid,
            downloadSuccessful,
                xmlSyntaxPassed,
                rdfSyntaxPassed,
                shaclPassed,
                overallPassed,
                rdfXml,
                graphPayload.nodes(),
                graphPayload.links(),
                results,
                message,
                overallPassed ? null : "Mindestens ein Abschnitt hat Fehler oder Violations gemeldet.");
    }

    private GraphPayload buildGraphPayload(Model model) {
        if (model == null || model.isEmpty()) {
            return new GraphPayload(List.of(), List.of());
        }

        Map<String, List<String>> classHints = buildClassHints(model);
        Map<String, RdfGraphNode> nodes = new LinkedHashMap<>();
        List<RdfGraphLink> links = new ArrayList<>();

        int count = 0;
        for (Statement statement : model.listStatements().toList()) {
            if (count >= MAX_GRAPH_TRIPLES) {
                break;
            }

            String sourceId = nodeId(statement.getSubject());
            String targetId = nodeId(statement.getObject());

                nodes.putIfAbsent(sourceId, toGraphNode(statement.getSubject(), classHints));
                nodes.putIfAbsent(targetId, toGraphNode(statement.getObject(), classHints));
                links.add(new RdfGraphLink(
                    sourceId,
                    targetId,
                    shortLabel(statement.getPredicate().toString()),
                    statement.getPredicate().toString()
                ));
            count++;
        }

        return new GraphPayload(new ArrayList<>(nodes.values()), links);
    }

    private RdfGraphNode toGraphNode(RDFNode node, Map<String, List<String>> classHints) {
        String id = nodeId(node);
        String type;
        if (node.isLiteral()) {
            type = "Literal";
        } else if (node.isAnon()) {
            type = "BlankNode";
        } else {
            type = "IRI";
        }
        List<String> classes = classHints.getOrDefault(id, List.of());
        return new RdfGraphNode(id, shortLabel(id), type, classes);
    }

    private Map<String, List<String>> buildClassHints(Model model) {
        Map<String, List<String>> classHints = new LinkedHashMap<>();

        for (Statement statement : model.listStatements().toList()) {
            if (!statement.getPredicate().equals(RDF.type)
                    || !statement.getSubject().isResource()
                    || !statement.getObject().isResource()) {
                continue;
            }

            String subjectId = nodeId(statement.getSubject());
            String classLabel = shortLabel(statement.getObject().asResource().toString());

            List<String> classes = classHints.computeIfAbsent(subjectId, key -> new ArrayList<>());
            if (!classes.contains(classLabel)) {
                classes.add(classLabel);
            }
        }

        classHints.replaceAll((key, value) -> Collections.unmodifiableList(value));
        return classHints;
    }

    private String nodeId(RDFNode node) {
        if (node.isLiteral()) {
            return "literal:" + node.asLiteral().getLexicalForm();
        }
        if (node.isAnon()) {
            return "_:" + node.asResource().getId().getLabelString();
        }
        return node.asResource().getURI();
    }

    private String nodeId(Resource resource) {
        if (resource.isAnon()) {
            return "_:" + resource.getId().getLabelString();
        }
        return resource.getURI();
    }

    private String shortLabel(String value) {
        if (value == null || value.isBlank()) {
            return "(leer)";
        }

        int hashPos = value.lastIndexOf('#');
        if (hashPos >= 0 && hashPos < value.length() - 1) {
            return value.substring(hashPos + 1);
        }

        int slashPos = value.lastIndexOf('/');
        if (slashPos >= 0 && slashPos < value.length() - 1) {
            return value.substring(slashPos + 1);
        }

        if (value.length() > 60) {
            return value.substring(0, 57) + "...";
        }
        return value;
    }

    private record GraphPayload(List<RdfGraphNode> nodes, List<RdfGraphLink> links) {
    }

    private String buildApiUrl(String itemId) {
        return DdbConstants.DDB_API_ITEMS_BASE + itemId + "/edm";
    }

    private byte[] downloadRdfXml(String apiUrl, boolean europeanaProfile) {
        HttpRequest.Builder requestBuilder = HttpRequest.newBuilder(URI.create(apiUrl))
            .timeout(Duration.ofSeconds(120))
                .header("Accept", "application/rdf+xml, application/xml;q=0.9, */*;q=0.8")
                .header("User-Agent", "edm-validator/0.0.1");

        if (europeanaProfile) {
            requestBuilder.header("accept-profile", DdbConstants.EUROPEANA_EDM_PROFILE);
        }

        HttpRequest request = requestBuilder.GET().build();

        try {
            HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new IllegalStateException("DDB API antwortete mit HTTP " + response.statusCode());
            }
            return response.body();
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Fehler beim Download der RDF/XML-Ressource: " + ex.getMessage(), ex);
        } catch (IOException ex) {
            throw new IllegalStateException("Fehler beim Download der RDF/XML-Ressource: " + ex.getMessage(), ex);
        }
    }

    private boolean allSucceededInSection(List<ValidationResultItem> items, String section) {
        boolean hasSection = false;
        for (ValidationResultItem item : items) {
            if (section.equals(item.section())) {
                hasSection = true;
                if (!item.success()) {
                    return false;
                }
            }
        }
        return hasSection;
    }
}
