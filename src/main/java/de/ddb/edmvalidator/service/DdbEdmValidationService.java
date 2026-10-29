package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.GraphResponse;
import de.ddb.edmvalidator.api.ValidationResponse;
import de.ddb.edmvalidator.api.ValidationResultItem;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.jspecify.annotations.Nullable;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * Coordinates the independent XML, XSD, RDF and SHACL checks for one document.
 * Per-request results, graph data and timings stay local to the invocation;
 * the injected engines manage their reusable schema caches.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class DdbEdmValidationService {

    private final DdbRdfSourceService sourceService;

    private final XmlSyntaxValidator xmlSyntaxValidator;
    private final EdmXsdValidator edmXsdValidator;
    private final JenaValidationEngine jenaValidationEngine;
    private final Rdf4jValidationEngine rdf4jValidationEngine;

    /**
     * Validates pasted RDF/XML when present, otherwise downloads a matching DDB item URL.
     * Missing input and download failures are returned as structured responses.
     *
     * @param inputUrl DDB item URL, unused when RDF/XML is supplied
     * @param rdfXmlInput pasted document, or {@code null} to use the URL
     * @param europeanaProfile requests the Europeana profile only for DDB downloads
     */
    public @NonNull ValidationResponse validate(@Nullable String inputUrl, @Nullable String rdfXmlInput,
                                       boolean europeanaProfile) {
        return validate(inputUrl, rdfXmlInput, europeanaProfile, null);
    }

    /** An optional absolute document IRI resolves local relative identifiers consistently across tools. */
    public @NonNull ValidationResponse validate(@Nullable String inputUrl, @Nullable String rdfXmlInput,
                                               boolean europeanaProfile, @Nullable String documentIri) {
        if (rdfXmlInput != null && !rdfXmlInput.isBlank()) {
            String checkedIri = null;
            if (documentIri != null && !documentIri.isBlank()) {
                try {
                    checkedIri = RdfInputIri.absolute(documentIri, false);
                } catch (IllegalArgumentException ex) {
                    return new ValidationResponse("Lokale RDF/XML-Eingabe", null,
                            true, true, false, false, false, false, false, rdfXmlInput,
                            Objects.requireNonNull(List.of()), Objects.requireNonNull(List.of()), Objects.requireNonNull(List.of()),
                            "Ungültige Dokument-IRI", "Dokument-IRI muss eine gültige absolute IRI sein.");
                }
            }
            byte[] rdfXmlBytes = rdfXmlInput.getBytes(StandardCharsets.UTF_8);
            return validateContent(
                    "Lokale RDF/XML-Eingabe",
                    null,
                    true,
                    true,
                    rdfXmlBytes,
                    rdfXmlInput,
                    checkedIri
            );
        }

        List<ValidationResultItem> results = new ArrayList<>();

        String normalizedInput = inputUrl == null ? "" : Objects.requireNonNull(inputUrl.trim());

        String apiUrl;
        try {
            apiUrl = sourceService.apiUrl(normalizedInput);
        } catch (IllegalArgumentException ex) {
            return new ValidationResponse(
                    normalizedInput,
                    null,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    null,
                    Objects.requireNonNull(List.of()),
                    Objects.requireNonNull(List.of()),
                    results,
                    "Ungültige DDB-Item-URL",
                    "Erwartetes Muster: https://www.deutsche-digitale-bibliothek.de/item/{ID}");
        }

        byte[] rdfXmlBytes;
        String rdfXml;
        try {
            rdfXmlBytes = downloadRdfXml(apiUrl, europeanaProfile);
            rdfXml = new String(rdfXmlBytes, StandardCharsets.UTF_8);
        } catch (IllegalStateException ex) {
            return new ValidationResponse(
                    normalizedInput,
                    apiUrl,
                    true,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    null,
                    Objects.requireNonNull(List.of()),
                    Objects.requireNonNull(List.of()),
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
                rdfXml,
                null
        );
    }

    /** Runs every applicable check even when an earlier engine reports a validation failure. */
    private @NonNull ValidationResponse validateContent(@NonNull String inputLabel,
                                               @Nullable String apiUrl,
                                               boolean patternValid,
                                               boolean downloadSuccessful,
                                               byte[] rdfXmlBytes,
                                               String rdfXml,
                                               @Nullable String documentIri) {
        String validationId = UUID.randomUUID().toString();
        long started = System.nanoTime();
        Map<String, Long> timings = new LinkedHashMap<>();
        List<ValidationResultItem> results = new ArrayList<>();
        log.info("Validierung {} gestartet: {} Bytes RDF/XML", validationId, rdfXmlBytes.length);

        results.add(runStep(validationId, "XML", timings, () -> xmlSyntaxValidator.validateWellFormed(rdfXmlBytes)));
        results.add(runStep(validationId, "EDM-XSD", timings, () -> edmXsdValidator.validateAgainstEdmXsd(rdfXmlBytes)));
        results.add(runStep(validationId, "Jena-Grammatik", timings, () -> documentIri == null
                ? jenaValidationEngine.validateRdfXmlGrammar(rdfXmlBytes)
                : jenaValidationEngine.validateRdfXmlGrammar(rdfXmlBytes, documentIri)));

        try (JenaValidationEngine.JenaParseOutcome jenaParse = runStep(validationId, "Jena-RDF", timings,
                () -> documentIri == null ? jenaValidationEngine.parseRdfSyntax(rdfXmlBytes)
                        : jenaValidationEngine.parseRdfSyntax(rdfXmlBytes, documentIri))) {
            results.add(jenaParse.result());

            Rdf4jValidationEngine.Rdf4jParseOutcome rdf4jParse = runStep(validationId, "RDF4J-RDF", timings,
                    () -> documentIri == null ? rdf4jValidationEngine.parseRdfSyntax(rdfXmlBytes)
                            : rdf4jValidationEngine.parseRdfSyntax(rdfXmlBytes, documentIri));
            results.add(rdf4jParse.result());

            results.add(runStep(validationId, "Jena-SHACL", timings,
                    () -> jenaValidationEngine.validateShacl(jenaParse.model(), rdfXmlBytes)));
            results.add(runStep(validationId, "RDF4J-SHACL", timings,
                    () -> rdf4jValidationEngine.validateShacl(rdf4jParse.model(), rdfXmlBytes)));

            GraphResponse graphPayload = runStep(validationId, "Graph", timings, () -> RdfGraphPreviewBuilder.build(jenaParse.model()));

            boolean xmlSyntaxPassed = allSucceededInSection(results, ValidationSections.XML);
            boolean edmXsdPassed = allSucceededInSection(results, ValidationSections.EDM_XSD);
            boolean rdfSyntaxPassed = allSucceededInSection(results, ValidationSections.RDF);
            boolean shaclPassed = allSucceededInSection(results, ValidationSections.SHACL);
            boolean overallPassed = xmlSyntaxPassed && edmXsdPassed && rdfSyntaxPassed && shaclPassed;

            String message = overallPassed
                    ? "Validierung erfolgreich (XML-Syntax, RDF-Syntax, SHACL)"
                    : "Validierung mit Befunden abgeschlossen";

            log.info("Validierung {} abgeschlossen: {} ms; Schritte (ms): {}; overallPassed={}",
                    validationId, TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started), timings, overallPassed);

            return new ValidationResponse(
                    inputLabel,
                    apiUrl,
                    patternValid,
                    downloadSuccessful,
                    xmlSyntaxPassed,
                    edmXsdPassed,
                    rdfSyntaxPassed,
                    shaclPassed,
                    overallPassed,
                    rdfXml,
                    graphPayload.graphNodes(),
                    graphPayload.graphLinks(),
                    results,
                    message,
                    overallPassed ? null : "Mindestens ein Abschnitt hat Fehler oder Violations gemeldet.");
        }
    }

    /** Records elapsed time without logging the document contents or replacing engine exceptions. */
    private <T> T runStep(String validationId, String step, Map<String, Long> timings, Supplier<T> action) {
        long started = System.nanoTime();
        log.debug("Validierung {}: {} gestartet", validationId, step);
        try {
            return action.get();
        } catch (RuntimeException ex) {
            log.error("Validierung {}: {} ist unerwartet fehlgeschlagen", validationId, step, ex);
            throw ex;
        } finally {
            long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
            timings.put(step, elapsedMillis);
            if (elapsedMillis >= 10_000) {
                log.warn("Validierung {}: {} dauerte {} ms", validationId, step, elapsedMillis);
            } else {
                log.debug("Validierung {}: {} abgeschlossen in {} ms", validationId, step, elapsedMillis);
            }
        }
    }

    private byte[] downloadRdfXml(String apiUrl, boolean europeanaProfile) {
        return sourceService.loadForValidation(apiUrl, europeanaProfile);
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
