package de.ddb.edmvalidator.service;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import de.ddb.edmvalidator.api.ValidationResultItem;
import org.eclipse.rdf4j.sail.helpers.AbstractSailConnection;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.jspecify.annotations.NonNull;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static java.util.Objects.requireNonNull;

class Rdf4jValidationEngineTest {

    private static final String VALID_RDF_XML = """
            <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                     xmlns:edm="http://www.europeana.eu/schemas/edm/"
                     xmlns:dc="http://purl.org/dc/elements/1.1/"
                     xmlns:ex="https://example.org/">
              <edm:ProvidedCHO rdf:about="https://example.org/item">
                <dc:title>Example</dc:title>
                <dc:subject>Example subject</dc:subject>
                <dc:language>de</dc:language>
                <edm:type>TEXT</edm:type>
              </edm:ProvidedCHO>
            </rdf:RDF>
            """;
    private static final String INVALID_RDF_XML = VALID_RDF_XML.replace(
            "<dc:title>Example</dc:title>",
            "<dc:title>Example</dc:title><ex:unexpected>Invalid property</ex:unexpected>");

    private final @NonNull ValidationIssueEnricher issueEnricher = new ValidationIssueEnricher();
    private final Rdf4jValidationEngine engine = new Rdf4jValidationEngine(
            new ValidationItemFactory(issueEnricher), issueEnricher);
    private final Logger connectionLogger = (Logger) LoggerFactory.getLogger(AbstractSailConnection.class);
    private final ListAppender<ILoggingEvent> connectionLogs = new ListAppender<>();

    @BeforeEach
    void captureConnectionLogs() {
        connectionLogs.list = Collections.synchronizedList(new ArrayList<>());
        connectionLogs.start();
        connectionLogger.addAppender(connectionLogs);
    }

    @AfterEach
    void releaseConnectionLogs() {
        connectionLogger.detachAppender(connectionLogs);
        connectionLogs.stop();
    }

    @Test
    void acceptsConformingDataWithoutClosingAnActiveTransaction() {
        ValidationResultItem result = validate(VALID_RDF_XML);

        assertTrue(result.success(), result.originalMessage());
        assertThat(result.metricValue()).isZero();
        assertNoImplicitRollback();
    }

    @Test
    void parsedSchemaIsImmutableAndSharedAcrossIndependentValidationRepositories() {
        var schema = engine.getRdf4jSchema();
        int size = schema.size();
        assertTrue(size > 0);
        assertThrows(UnsupportedOperationException.class, schema::clear);
        assertTrue(validate(VALID_RDF_XML).success());
        assertViolation(validate(INVALID_RDF_XML));
        assertSame(schema, engine.getRdf4jSchema(), "Repeated requests reuse the parsed schema statements");
        assertThat(schema).hasSize(size);
        assertNoImplicitRollback();
    }

    @Test
    void retainsViolationDetailsAndCleansUpRepeatedFailedTransactions() {
        for (int i = 0; i < 2; i++) {
            assertViolation(validate(INVALID_RDF_XML));
            ValidationResultItem conforming = validate(VALID_RDF_XML);
            assertTrue(conforming.success(), conforming.originalMessage());
        }

        assertNoImplicitRollback();
    }

    @Test
    void keepsConcurrentValidationResultsIsolated() throws Exception {
        try (var executor = Executors.newFixedThreadPool(4)) {
            List<Future<ValidationResultItem>> futures = new ArrayList<>();
            for (int i = 0; i < 4; i++) {
                String input = i % 2 == 0 ? INVALID_RDF_XML : VALID_RDF_XML;
                futures.add(executor.submit(() -> validate(input)));
            }

            for (int i = 0; i < futures.size(); i++) {
                ValidationResultItem result = futures.get(i).get(60, TimeUnit.SECONDS);
                if (i % 2 == 0) {
                    assertViolation(result);
                } else {
                    assertTrue(result.success(), result.originalMessage());
                    assertThat(result.metricValue()).isZero();
                }
            }
        }

        assertNoImplicitRollback();
    }

    private ValidationResultItem validate(String input) {
        byte[] bytes = input.getBytes(StandardCharsets.UTF_8);
        Rdf4jValidationEngine.Rdf4jParseOutcome parsed = engine.parseRdfSyntax(bytes);
        assertThat(parsed.result().success()).isTrue();
        return engine.validateShacl(requireNonNull(parsed.model(), "Successful RDF parsing must provide a model"), bytes);
    }

    private void assertViolation(ValidationResultItem result) {
        assertThat(result.success()).isFalse();
        assertThat(result.metricValue()).isPositive();
        assertThat(result.originalMessage())
                .contains("Focus=https://example.org/item", "Path=https://example.org/unexpected");
    }

    private void assertNoImplicitRollback() {
        assertThat(connectionLogs.list)
                .noneMatch(event -> event.getFormattedMessage().contains("Rolling back transaction due to connection close"));
    }
}
