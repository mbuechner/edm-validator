package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.ValidationResultItem;
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
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collection;

@Component
public class JenaValidationEngine {

    private static final String SHAPES_RESOURCE_PATH = "schema/edm_ext_shacl_shapes.ttl";
    private static final String CLASS_DEFINITIONS_RESOURCE_PATH = "schema/edm_ext_class_definitions.ttl";
    private static final String JENA_INIT_ERROR_PREFIX = "Jena konnte nicht initialisiert werden";
    private static final int MAX_SHACL_DETAILS = 8;

    private final ValidationItemFactory itemFactory;
    private final ValidationIssueEnricher issueEnricher;

    private volatile Shapes jenaShapes;

    public JenaValidationEngine(ValidationItemFactory itemFactory, ValidationIssueEnricher issueEnricher) {
        this.itemFactory = itemFactory;
        this.issueEnricher = issueEnricher;
    }

    public ValidationResultItem validateRdfXmlGrammar(byte[] rdfXmlBytes) {
        try {
            RDFParser.create()
                    .source(new ByteArrayInputStream(rdfXmlBytes))
                    .base(DdbConstants.DDB_RESOURCE_BASE)
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

    public JenaParseOutcome parseRdfSyntax(byte[] rdfXmlBytes) {
        try {
            Model model = ModelFactory.createDefaultModel();
            RDFDataMgr.read(model, new ByteArrayInputStream(rdfXmlBytes),
                    DdbConstants.DDB_RESOURCE_BASE, Lang.RDFXML);

            if (model.isEmpty()) {
                return new JenaParseOutcome(
                        itemFactory.failure(ValidationSections.RDF, "Apache Jena", "RDF-Graph ist leer", null, null, rdfXmlBytes),
                        null);
            }

            return new JenaParseOutcome(
                    itemFactory.success(ValidationSections.RDF, "Apache Jena", "RDF erfolgreich geladen", model.size(), "Triples"),
                    model);
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
        }
    }

    public ValidationResultItem validateShacl(Model dataModel, byte[] rdfXmlBytes) {
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

    private Shapes getJenaShapes() {
        Shapes current = jenaShapes;
        if (current != null) {
            return current;
        }

        synchronized (this) {
            if (jenaShapes == null) {
                Model shapeModel = ModelFactory.createDefaultModel();
                try (InputStream shapesInput = new ClassPathResource(SHAPES_RESOURCE_PATH).getInputStream();
                     InputStream classesInput = new ClassPathResource(CLASS_DEFINITIONS_RESOURCE_PATH).getInputStream()) {
                    RDFDataMgr.read(shapeModel, shapesInput, Lang.TURTLE);
                    RDFDataMgr.read(shapeModel, classesInput, Lang.TURTLE);
                } catch (IOException ex) {
                    throw new IllegalStateException("Konnte SHACL-Shapes nicht laden: " + ex.getMessage(), ex);
                }

                Model enhancedShapeModel = ModelFactory.createInfModel(ReasonerRegistry.getOWLReasoner(), shapeModel);
                jenaShapes = Shapes.parse(enhancedShapeModel.getGraph());
            }
            return jenaShapes;
        }
    }

    private String jenaInitErrorMessage(Throwable error) {
        Throwable root = error;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        String detail = root.getMessage();
        if (detail == null || detail.isBlank()) {
            detail = error.getClass().getSimpleName();
        }
        return JENA_INIT_ERROR_PREFIX + ": " + detail;
    }

    public record JenaParseOutcome(ValidationResultItem result, Model model) {
    }
}
