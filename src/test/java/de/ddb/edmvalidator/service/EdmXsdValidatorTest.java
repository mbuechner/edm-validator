package de.ddb.edmvalidator.service;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import de.ddb.edmvalidator.api.ValidationResultItem;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static java.util.Objects.requireNonNull;

class EdmXsdValidatorTest {
    private static final byte[] VALID_XML = "<t:record xmlns:t=\"urn:test\">value</t:record>".getBytes(StandardCharsets.UTF_8);
    private static final String SCHEMA = """
            <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test"
                       xmlns:v="urn:types" elementFormDefault="qualified">
              <xs:import namespace="urn:types" schemaLocation="types.xsd"/>
              <xs:element name="record" type="v:Name"/>
            </xs:schema>
            """;
    private static final String TYPES = """
            <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:types">
              <xs:simpleType name="Name"><xs:restriction base="xs:string">
                <xs:minLength value="1"/>
              </xs:restriction></xs:simpleType>
            </xs:schema>
            """;

    private HttpServer server;
    private ExecutorService serverExecutor;
    private final AtomicInteger requests = new AtomicInteger();

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        serverExecutor = Executors.newVirtualThreadPerTaskExecutor();
        server.setExecutor(serverExecutor);
        server.start();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
        serverExecutor.shutdownNow();
    }

    @Test
    void startupLoadsRelativeImportsAndValidationKeepsUsingTheCompiledCache() {
        server.createContext("/schemas/main.xsd", exchange -> respond(exchange, 200, SCHEMA));
        server.createContext("/schemas/types.xsd", exchange -> respond(exchange, 200, TYPES));
        EdmXsdValidator validator = validator(Duration.ofSeconds(2), Duration.ofSeconds(3), Duration.ofSeconds(30));

        assertDoesNotThrow(validator::preloadSchema);
        assertEquals(2, requests.get());
        assertTrue(validator.validateAgainstEdmXsd(VALID_XML).success());
        ValidationResultItem invalid = validator.validateAgainstEdmXsd(
                "<t:record xmlns:t=\"urn:test\"/>".getBytes(StandardCharsets.UTF_8));
        assertFalse(invalid.success());
        assertNotNull(invalid.line());
        assertFalse(invalid.originalMessage().contains("konnte nicht geladen werden"));
        assertEquals(2, requests.get(), "No schema should be downloaded during document validation");
    }

    @Test
    void relativeImportsResolveAgainstTheEffectiveSchemaUrlAfterARedirect() {
        server.createContext("/schemas/main.xsd", exchange -> {
            requests.incrementAndGet();
            try (exchange) {
                exchange.getResponseHeaders().set("Location", "/redirected/main.xsd");
                exchange.sendResponseHeaders(302, -1);
            }
        });
        server.createContext("/redirected/main.xsd", exchange -> respond(exchange, 200, SCHEMA));
        server.createContext("/redirected/types.xsd", exchange -> respond(exchange, 200, TYPES));
        EdmXsdValidator validator = validator(Duration.ofSeconds(2), Duration.ofSeconds(3), Duration.ofSeconds(30));

        validator.preloadSchema();
        assertTrue(validator.validateAgainstEdmXsd(VALID_XML).success());
        assertEquals(3, requests.get());
    }

    @Test
    void unavailableSchemaDoesNotPreventStartupAndConcurrentValidationsShareTheFailureCache() throws Exception {
        server.createContext("/schemas/main.xsd", exchange -> respond(exchange, 503, "Unavailable"));
        EdmXsdValidator validator = validator(Duration.ofSeconds(1), Duration.ofSeconds(2), Duration.ofSeconds(30));
        assertDoesNotThrow(validator::preloadSchema);

        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var futures = new ArrayList<Future<ValidationResultItem>>();
            for (int i = 0; i < 8; i++) {
                futures.add(executor.submit(() -> validator.validateAgainstEdmXsd(VALID_XML)));
            }
            for (Future<ValidationResultItem> future : futures) {
                ValidationResultItem result = future.get();
                assertFalse(result.success());
                assertTrue(result.originalMessage().contains("EDM-XSD konnte nicht geladen werden"));
                assertTrue(result.originalMessage().contains("HTTP 503"));
                assertNull(result.line(), "A schema download error is not a line error in the user's document");
            }
        }
        assertEquals(1, requests.get());
    }

    @Test
    void failedStartupCanRecoverAfterTheRetryDelayAndThenKeepsTheSuccessfulCache() throws Exception {
        AtomicBoolean available = new AtomicBoolean();
        server.createContext("/schemas/main.xsd", exchange -> respond(exchange,
                available.get() ? 200 : 503, available.get() ? SCHEMA : "Unavailable"));
        server.createContext("/schemas/types.xsd", exchange -> respond(exchange, 200, TYPES));
        EdmXsdValidator validator = validator(Duration.ofSeconds(1), Duration.ofSeconds(2), Duration.ofMillis(100));

        validator.preloadSchema();
        available.set(true);
        assertFalse(validator.validateAgainstEdmXsd(VALID_XML).success());
        assertEquals(1, requests.get());
        Thread.sleep(150);
        assertTrue(validator.validateAgainstEdmXsd(VALID_XML).success());
        assertTrue(validator.validateAgainstEdmXsd(VALID_XML).success());
        assertEquals(3, requests.get());
    }

    @Test
    void aStalledMainSchemaBodyTimesOutAndDoesNotGetCachedAsAValidSchema() {
        CountDownLatch release = new CountDownLatch(1);
        server.createContext("/schemas/main.xsd", exchange -> stallBody(exchange, release));
        EdmXsdValidator validator = validator(Duration.ofMillis(150), Duration.ofSeconds(1), Duration.ofSeconds(30));
        try {
            ValidationResultItem result = assertTimeoutPreemptively(requireNonNull(Duration.ofSeconds(3)),
                    () -> validator.validateAgainstEdmXsd(VALID_XML));
            assertFalse(result.success());
            assertTrue(result.originalMessage().contains("Schema-Abruf fehlgeschlagen"));
            assertNull(result.line());
            assertFalse(validator.validateAgainstEdmXsd(VALID_XML).success());
            assertEquals(1, requests.get());
        } finally {
            release.countDown();
        }
    }

    @Test
    void aStalledImportedSchemaBodyUsesTheSameTimeoutInsteadOfJaxpsUrlLoader() {
        CountDownLatch release = new CountDownLatch(1);
        server.createContext("/schemas/main.xsd", exchange -> respond(exchange, 200, SCHEMA));
        server.createContext("/schemas/types.xsd", exchange -> stallBody(exchange, release));
        EdmXsdValidator validator = validator(Duration.ofMillis(150), Duration.ofSeconds(1), Duration.ofSeconds(30));
        try {
            ValidationResultItem result = assertTimeoutPreemptively(requireNonNull(Duration.ofSeconds(3)),
                    () -> validator.validateAgainstEdmXsd(VALID_XML));
            assertFalse(result.success());
            assertTrue(result.originalMessage().contains("types.xsd"));
            assertNull(result.line());
            assertEquals(2, requests.get());
        } finally {
            release.countDown();
        }
    }

    @Test
    void importsShareTheOverallSchemaLoadingBudget() {
        server.createContext("/schemas/main.xsd", exchange -> delayedResponse(exchange, SCHEMA));
        server.createContext("/schemas/types.xsd", exchange -> delayedResponse(exchange, TYPES));
        EdmXsdValidator validator = validator(Duration.ofSeconds(2), Duration.ofMillis(300), Duration.ofSeconds(30));

        ValidationResultItem result = assertTimeoutPreemptively(requireNonNull(Duration.ofSeconds(3)),
                () -> validator.validateAgainstEdmXsd(VALID_XML));
        assertFalse(result.success(), "Two 200ms downloads must not each get a fresh 300ms budget");
        assertNull(result.line());
        assertEquals(2, requests.get());
    }

    private EdmXsdValidator validator(Duration requestTimeout, Duration loadTimeout, Duration retryDelay) {
        URI uri = URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/schemas/main.xsd");
        return new EdmXsdValidator(new ValidationItemFactory(new ValidationIssueEnricher()), uri,
                Duration.ofSeconds(1), requestTimeout, loadTimeout, retryDelay);
    }

    private void respond(HttpExchange exchange, int status, String content) throws IOException {
        requests.incrementAndGet();
        writeResponse(exchange, status, content);
    }

    private void writeResponse(HttpExchange exchange, int status, String content) throws IOException {
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        try (exchange) {
            exchange.sendResponseHeaders(status, bytes.length);
            exchange.getResponseBody().write(bytes);
        }
    }

    private void stallBody(HttpExchange exchange, CountDownLatch release) throws IOException {
        requests.incrementAndGet();
        try (exchange) {
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write('<');
            exchange.getResponseBody().flush();
            try {
                release.await();
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private void delayedResponse(HttpExchange exchange, String content) throws IOException {
        requests.incrementAndGet();
        try {
            Thread.sleep(200);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
        }
        writeResponse(exchange, 200, content);
    }
}
