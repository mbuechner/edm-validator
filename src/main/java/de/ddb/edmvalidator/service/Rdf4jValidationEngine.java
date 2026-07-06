package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.ValidationResultItem;
import org.eclipse.rdf4j.model.Model;
import org.eclipse.rdf4j.model.Resource;
import org.eclipse.rdf4j.model.Statement;
import org.eclipse.rdf4j.model.Value;
import org.eclipse.rdf4j.model.vocabulary.RDF4J;
import org.eclipse.rdf4j.model.vocabulary.SHACL;
import org.eclipse.rdf4j.repository.sail.SailRepository;
import org.eclipse.rdf4j.repository.sail.SailRepositoryConnection;
import org.eclipse.rdf4j.rio.RDFFormat;
import org.eclipse.rdf4j.rio.RDFParseException;
import org.eclipse.rdf4j.rio.Rio;
import org.eclipse.rdf4j.sail.memory.MemoryStore;
import org.eclipse.rdf4j.sail.shacl.ShaclSail;
import org.eclipse.rdf4j.sail.shacl.ShaclSailValidationException;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Deque;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.Set;

@Component
public class Rdf4jValidationEngine {

    private static final String SHAPES_RESOURCE_PATH = "schema/edm_ext_shacl_shapes.ttl";
    private static final String CLASS_DEFINITIONS_RESOURCE_PATH = "schema/edm_ext_class_definitions.ttl";
    private static final int MAX_SHACL_DETAILS = 8;

    private final ValidationItemFactory itemFactory;
    private final ValidationIssueEnricher issueEnricher;

    private volatile byte[] rdf4jShapesBytes;
    private volatile byte[] rdf4jClassDefinitionsBytes;

    public Rdf4jValidationEngine(ValidationItemFactory itemFactory, ValidationIssueEnricher issueEnricher) {
        this.itemFactory = itemFactory;
        this.issueEnricher = issueEnricher;
    }

    public Rdf4jParseOutcome parseRdfSyntax(byte[] rdfXmlBytes) {
        try {
            org.eclipse.rdf4j.model.Model model = Rio.parse(
                    new ByteArrayInputStream(rdfXmlBytes),
                    DdbConstants.DDB_RESOURCE_BASE,
                    RDFFormat.RDFXML);

            if (model.isEmpty()) {
                return new Rdf4jParseOutcome(
                        itemFactory.failure(ValidationSections.RDF, "RDF4J Rio", "RDF-Modell ist leer", null, null, rdfXmlBytes),
                        null);
            }

            return new Rdf4jParseOutcome(
                    itemFactory.success(ValidationSections.RDF, "RDF4J Rio", "RDF erfolgreich geladen", (long) model.size(), "Statements"),
                    model);
        } catch (RDFParseException ex) {
            return new Rdf4jParseOutcome(
                    itemFactory.failure(ValidationSections.RDF, "RDF4J Rio", ex.getMessage(), toInteger(ex.getLineNumber()), toInteger(ex.getColumnNumber()), rdfXmlBytes),
                    null);
        } catch (Exception ex) {
            ValidationIssueEnricher.LineCol lineCol = issueEnricher.extractLineCol(ex.getMessage());
            return new Rdf4jParseOutcome(
                    itemFactory.failure(ValidationSections.RDF, "RDF4J Rio", ex.getMessage(), lineCol.line(), lineCol.column(), rdfXmlBytes),
                    null);
        }
    }

    public ValidationResultItem validateShacl(org.eclipse.rdf4j.model.Model dataModel, byte[] rdfXmlBytes) {
        if (dataModel == null) {
            return itemFactory.failure(ValidationSections.SHACL, "RDF4J SHACL", "SHACL wurde übersprungen, weil RDF4J-RDF-Parsing fehlgeschlagen ist.", null, null, rdfXmlBytes);
        }

        SailRepository repository = new SailRepository(new ShaclSail(new MemoryStore()));
        try {
            repository.init();

            try (SailRepositoryConnection connection = repository.getConnection()) {
                connection.begin();
                connection.add(new ByteArrayInputStream(getRdf4jShapesBytes()), "", RDFFormat.TURTLE, RDF4J.SHACL_SHAPE_GRAPH);
                connection.add(new ByteArrayInputStream(getRdf4jClassDefinitionsBytes()), "", RDFFormat.TURTLE, RDF4J.SHACL_SHAPE_GRAPH);
                connection.commit();

                connection.begin();
                connection.add(dataModel);
                connection.commit();
            }

            return itemFactory.success(ValidationSections.SHACL, "RDF4J SHACL", "Keine SHACL-Violations gefunden", 0L, "Violations");
        } catch (ShaclSailValidationException ex) {
            return toRdf4jShaclFailure(ex, rdfXmlBytes);
        } catch (Exception ex) {
            ShaclSailValidationException shaclCause = findShaclValidationException(ex);
            if (shaclCause != null) {
                return toRdf4jShaclFailure(shaclCause, rdfXmlBytes);
            }
            if (looksLikeWrappedShaclValidation(ex)) {
                return itemFactory.failure(
                        ValidationSections.SHACL,
                        "RDF4J SHACL",
                        buildWrappedShaclFallbackMessage(ex),
                        null,
                        null,
                        rdfXmlBytes
                );
            }
            return itemFactory.failure(ValidationSections.SHACL, "RDF4J SHACL", ex.getMessage(), null, null, rdfXmlBytes);
        } finally {
            repository.shutDown();
        }
    }

    private ValidationResultItem toRdf4jShaclFailure(ShaclSailValidationException ex, byte[] rdfXmlBytes) {
        Model reportModel = ex.validationReportAsModel();
        long violations = reportModel.filter(null, SHACL.RESULT, null).size();
        return itemFactory.failure(
                ValidationSections.SHACL,
                "RDF4J SHACL",
                buildRdf4jViolationMessage(reportModel, violations),
                null,
                null,
                rdfXmlBytes,
                violations,
                "Violations"
        );
    }

    private ShaclSailValidationException findShaclValidationException(Throwable throwable) {
        if (throwable == null) {
            return null;
        }

        Deque<Throwable> queue = new ArrayDeque<>();
        Set<Throwable> visited = Collections.newSetFromMap(new IdentityHashMap<>());
        queue.add(throwable);

        while (!queue.isEmpty()) {
            Throwable current = queue.removeFirst();
            if (current == null || !visited.add(current)) {
                continue;
            }

            if (current instanceof ShaclSailValidationException validationException) {
                return validationException;
            }

            if (current.getCause() != null) {
                queue.addLast(current.getCause());
            }
            for (Throwable suppressed : current.getSuppressed()) {
                if (suppressed != null) {
                    queue.addLast(suppressed);
                }
            }
        }
        return null;
    }

    private boolean looksLikeWrappedShaclValidation(Throwable throwable) {
        String message = throwable == null ? null : throwable.getMessage();
        if (message != null && message.contains("ShaclSailValidationException")) {
            return true;
        }

        Throwable root = rootCause(throwable);
        return root != null
                && root.getMessage() != null
                && root.getMessage().contains("ShaclSailValidationException");
    }

    private String buildWrappedShaclFallbackMessage(Throwable throwable) {
        Throwable root = rootCause(throwable);
        String rootMessage = root == null || root.getMessage() == null || root.getMessage().isBlank()
                ? "keine zusätzliche Ursache verfügbar"
                : root.getMessage();

        return "RDF4J meldet SHACL-Validierungsfehler, liefert in diesem Lauf aber keinen auslesbaren Validation-Report. " +
                "Bitte nutze die detaillierten Violations aus dem Jena-SHACL-Block. Ursache: " + rootMessage;
    }

    private Throwable rootCause(Throwable throwable) {
        Throwable current = throwable;
        int guard = 0;
        while (current != null && current.getCause() != null && current.getCause() != current && guard < 20) {
            current = current.getCause();
            guard++;
        }
        return current;
    }

    private String buildRdf4jViolationMessage(Model reportModel, long violations) {
        StringBuilder sb = new StringBuilder();
        sb.append("SHACL-Violations gefunden (Anzahl: ").append(violations).append("). ");

        Set<Resource> resultResources = new LinkedHashSet<>();
        for (Statement statement : reportModel.filter(null, SHACL.RESULT, null)) {
            if (statement.getObject() instanceof Resource resource) {
                resultResources.add(resource);
            }
        }

        int i = 0;
        for (Resource result : resultResources) {
            if (i >= MAX_SHACL_DETAILS) {
                break;
            }
            if (i > 0) {
                sb.append(" | ");
            }

            String focusNode = firstObjectValue(reportModel, result, SHACL.FOCUS_NODE);
            String resultPath = firstObjectValue(reportModel, result, SHACL.RESULT_PATH);
            String message = firstObjectValue(reportModel, result, SHACL.RESULT_MESSAGE);

            sb.append(i + 1).append(") ");
            if (focusNode != null) {
                sb.append("Focus=").append(focusNode).append("; ");
            }
            if (resultPath != null) {
                sb.append("Path=").append(resultPath).append("; ");
            }
            sb.append("Message=").append(message != null ? message : "(keine Meldung)");
            i++;
        }

        if (resultResources.size() > MAX_SHACL_DETAILS) {
            sb.append(" | ... weitere ").append(resultResources.size() - MAX_SHACL_DETAILS).append(" Violations");
        }

        return sb.toString();
    }

    private String firstObjectValue(Model model, Resource subject, org.eclipse.rdf4j.model.IRI predicate) {
        Value value = model.filter(subject, predicate, null)
                .objects()
                .stream()
                .findFirst()
                .orElse(null);
        return value == null ? null : value.stringValue();
    }

    private Integer toInteger(long value) {
        if (value <= 0 || value > Integer.MAX_VALUE) {
            return null;
        }
        return (int) value;
    }

    private byte[] getRdf4jShapesBytes() {
        byte[] current = rdf4jShapesBytes;
        if (current != null) {
            return current;
        }

        synchronized (this) {
            if (rdf4jShapesBytes == null) {
                try (InputStream inputStream = new ClassPathResource(SHAPES_RESOURCE_PATH).getInputStream()) {
                    rdf4jShapesBytes = inputStream.readAllBytes();
                } catch (IOException ex) {
                    throw new IllegalStateException("Konnte SHACL-Shapes nicht laden: " + ex.getMessage(), ex);
                }
            }
            return rdf4jShapesBytes;
        }
    }

    private byte[] getRdf4jClassDefinitionsBytes() {
        byte[] current = rdf4jClassDefinitionsBytes;
        if (current != null) {
            return current;
        }

        synchronized (this) {
            if (rdf4jClassDefinitionsBytes == null) {
                try (InputStream inputStream = new ClassPathResource(CLASS_DEFINITIONS_RESOURCE_PATH).getInputStream()) {
                    rdf4jClassDefinitionsBytes = inputStream.readAllBytes();
                } catch (IOException ex) {
                    throw new IllegalStateException("Konnte SHACL-Klassendefinitionen nicht laden: " + ex.getMessage(), ex);
                }
            }
            return rdf4jClassDefinitionsBytes;
        }
    }

    public record Rdf4jParseOutcome(ValidationResultItem result, org.eclipse.rdf4j.model.Model model) {
    }
}
