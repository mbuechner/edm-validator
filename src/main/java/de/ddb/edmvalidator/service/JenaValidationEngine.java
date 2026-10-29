package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.ValidationResultItem;
import lombok.RequiredArgsConstructor;
import org.apache.jena.reasoner.ReasonerRegistry;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFDataMgr;
import org.apache.jena.riot.RDFParser;
import org.apache.jena.riot.RiotException;
import org.apache.jena.riot.system.ErrorHandlerFactory;
import org.apache.jena.riot.system.StreamRDFLib;
import org.apache.jena.shacl.Shapes;
import org.apache.jena.shacl.ShaclValidator;
import org.apache.jena.shacl.ValidationReport;
import org.jspecify.annotations.Nullable;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collection;

/**
 * Parses RDF/XML and evaluates the bundled SHACL shapes with Apache Jena.
 * Parsed data models belong to the caller; the inferred shapes are initialized
 * once and shared by subsequent validation requests.
 */
@Component
@RequiredArgsConstructor
public class JenaValidationEngine {

    private static final String SHAPES_RESOURCE_PATH = "schema/edm_ext_shacl_shapes.ttl";
    private static final String CLASS_DEFINITIONS_RESOURCE_PATH = "schema/edm_ext_class_definitions.ttl";
    private static final String JENA_INIT_ERROR_PREFIX = "Jena konnte nicht initialisiert werden";
    private static final int MAX_SHACL_DETAILS = 8;

    private final ValidationItemFactory itemFactory;
    private final ValidationIssueEnricher issueEnricher;

    private volatile @Nullable Shapes jenaShapes;

    /** Checks RDF/XML grammar without retaining the parsed statements. */
    public ValidationResultItem validateRdfXmlGrammar(byte[] rdfXmlBytes) {
        return validateRdfXmlGrammar(rdfXmlBytes, DdbConstants.DDB_RESOURCE_BASE);
    }

    /** Uses the same local document base as the other tools when resolving relative IRIs. */
    public ValidationResultItem validateRdfXmlGrammar(byte[] rdfXmlBytes, String documentIri) {
        try {
            RDFParser.create()
                    .source(new ByteArrayInputStream(rdfXmlBytes))
                    .base(documentIri)
                    .lang(Lang.RDFXML)
                    .errorHandler(ErrorHandlerFactory.errorHandlerStrict)
                    .parse(StreamRDFLib.sinkNull());

            return itemFactory.success(ValidationSections.RDF, "Jena RDF/XML Grammar", "RDF/XML-Grammatik ist gültig", null, null);
        } catch (RiotException ex) {
            ValidationIssueEnricher.LineCol lineCol = issueEnricher.extractLineCol(ex.getMessage());
            return itemFactory.failure(ValidationSections.RDF, "Jena RDF/XML Grammar", ex.getMessage(), lineCol.line(), lineCol.column(), rdfXmlBytes);
        } catch (LinkageError ex) {
            return itemFactory.failure(ValidationSections.RDF, "Jena RDF/XML Grammar", jenaInitErrorMessage(ex), null, null, rdfXmlBytes);
        } catch (Exception ex) {
            return itemFactory.failure(ValidationSections.RDF, "Jena RDF/XML Grammar", ex.getMessage(), null, null, rdfXmlBytes);
        }
    }

    /**
     * Parses a nonempty RDF graph for later SHACL validation and graph rendering.
     * A failed or empty parse returns a failure result with a {@code null} model.
     */
    public JenaParseOutcome parseRdfSyntax(byte[] rdfXmlBytes) {
        return parseRdfSyntax(rdfXmlBytes, DdbConstants.DDB_RESOURCE_BASE);
    }

    /** Parses against an already checked document IRI without fetching that IRI. */
    public JenaParseOutcome parseRdfSyntax(byte[] rdfXmlBytes, String documentIri) {
        Model model = null;
        boolean transferred = false;
        try {
            model = ModelFactory.createDefaultModel();
            RDFDataMgr.read(model, new ByteArrayInputStream(rdfXmlBytes),
                    documentIri, Lang.RDFXML);

            if (model.isEmpty()) {
                return new JenaParseOutcome(
                        itemFactory.failure(ValidationSections.RDF, "Apache Jena", "RDF-Graph ist leer", null, null, rdfXmlBytes),
                        null);
            }

            JenaParseOutcome outcome = new JenaParseOutcome(
                    itemFactory.success(ValidationSections.RDF, "Apache Jena", "RDF erfolgreich geladen", model.size(), "Triples"),
                    model);
            transferred = true;
            return outcome;
        } catch (RiotException ex) {
            ValidationIssueEnricher.LineCol lineCol = issueEnricher.extractLineCol(ex.getMessage());
            return new JenaParseOutcome(
                    itemFactory.failure(ValidationSections.RDF, "Apache Jena", ex.getMessage(), lineCol.line(), lineCol.column(), rdfXmlBytes),
                    null);
        } catch (LinkageError ex) {
            return new JenaParseOutcome(
                    itemFactory.failure(ValidationSections.RDF, "Apache Jena", jenaInitErrorMessage(ex), null, null, rdfXmlBytes),
                    null);
        } catch (Exception ex) {
            return new JenaParseOutcome(
                    itemFactory.failure(ValidationSections.RDF, "Apache Jena", ex.getMessage(), null, null, rdfXmlBytes),
                    null);
        } finally {
            if (model != null && !transferred) {
                model.close();
            }
        }
    }

    /**
     * Validates a parsed graph, or reports that validation was skipped when parsing failed.
     * At most eight violation details are included in the returned message.
     */
    public ValidationResultItem validateShacl(@Nullable Model dataModel, byte[] rdfXmlBytes) {
        if (dataModel == null) {
            return itemFactory.failure(ValidationSections.SHACL, "Jena SHACL", "SHACL wurde übersprungen, weil Jena-RDF-Parsing fehlgeschlagen ist.", null, null, rdfXmlBytes);
        }

        try {
            Shapes shapes = getJenaShapes();
            ValidationReport report = ShaclValidator.get().validate(shapes, dataModel.getGraph());
            long violations = report.getEntries().size();

            if (report.conforms()) {
                return itemFactory.success(ValidationSections.SHACL, "Jena SHACL", "Keine SHACL-Violations gefunden", violations, "Violations");
            }
            return itemFactory.failure(
                    ValidationSections.SHACL,
                    "Jena SHACL",
                    buildJenaViolationMessage(report),
                    null,
                    null,
                    rdfXmlBytes,
                    violations,
                    "Violations"
            );
        } catch (LinkageError ex) {
            return itemFactory.failure(ValidationSections.SHACL, "Jena SHACL", jenaInitErrorMessage(ex), null, null, rdfXmlBytes);
        } catch (Exception ex) {
            return itemFactory.failure(ValidationSections.SHACL, "Jena SHACL", ex.getMessage(), null, null, rdfXmlBytes);
        }
    }

    private String buildJenaViolationMessage(ValidationReport report) {
        Collection<?> entries = report.getEntries();
        StringBuilder sb = new StringBuilder();
        sb.append("SHACL-Violations gefunden (Anzahl: ").append(entries.size()).append("). ");

        int limit = Math.min(entries.size(), MAX_SHACL_DETAILS);
        int i = 0;
        for (Object entry : entries) {
            if (i >= limit) {
                break;
            }
            if (i > 0) {
                sb.append(" | ");
            }
            sb.append(i + 1).append(") ").append(entry);
            i++;
        }

        if (entries.size() > limit) {
            sb.append(" | ... weitere ").append(entries.size() - limit).append(" Violations");
        }

        return sb.toString();
    }

    /** Publishes the fully parsed, inferred shapes only after initialization succeeds. */
    private Shapes getJenaShapes() {
        Shapes current = jenaShapes;
        if (current != null) {
            return current;
        }

        synchronized (this) {
            current = jenaShapes;
            if (current == null) {
                Model shapeModel = ModelFactory.createDefaultModel();
                try (InputStream shapesInput = new ClassPathResource(SHAPES_RESOURCE_PATH).getInputStream();
                     InputStream classesInput = new ClassPathResource(CLASS_DEFINITIONS_RESOURCE_PATH).getInputStream()) {
                    RDFDataMgr.read(shapeModel, shapesInput, Lang.TURTLE);
                    RDFDataMgr.read(shapeModel, classesInput, Lang.TURTLE);
                } catch (IOException ex) {
                    throw new IllegalStateException("Konnte SHACL-Shapes nicht laden: " + ex.getMessage(), ex);
                }

                Model enhancedShapeModel = ModelFactory.createInfModel(ReasonerRegistry.getOWLReasoner(), shapeModel);
                current = Shapes.parse(enhancedShapeModel.getGraph());
                jenaShapes = current;
            }
            return current;
        }
    }

    private String jenaInitErrorMessage(Throwable error) {
        Throwable root = error;
        Throwable cause = root.getCause();
        while (cause != null && cause != root) {
            root = cause;
            cause = root.getCause();
        }
        String detail = root.getMessage();
        if (detail == null || detail.isBlank()) {
            detail = error.getClass().getSimpleName();
        }
        return JENA_INIT_ERROR_PREFIX + ": " + detail;
    }

    /** Owns the successful parse's data model until all downstream checks and projection finish. */
    public record JenaParseOutcome(ValidationResultItem result, @Nullable Model model) implements AutoCloseable {
        @Override
        public void close() {
            if (model != null) {
                model.close();
            }
        }
    }
}
