package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.ValidationResultItem;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.jspecify.annotations.Nullable;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.w3c.dom.bootstrap.DOMImplementationRegistry;
import org.w3c.dom.ls.DOMImplementationLS;
import org.w3c.dom.ls.LSInput;
import org.xml.sax.SAXException;
import org.xml.sax.SAXParseException;

import javax.xml.XMLConstants;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import javax.xml.validation.Validator;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Validates RDF/XML against one compiled EDM schema shared by all requests.
 *
 * <p>Startup preloads the schema and its dependencies. Failed loads are cached briefly
 * so an unavailable schema server cannot trigger one download per waiting request.
 * Only the immutable {@link Schema} is shared; each document gets its own validator.
 */
@Component
@Slf4j
public class EdmXsdValidator {

    private static final String EDM_XSD_URL = "https://www.europeana.eu/schemas/edm/EDM.xsd";

    private final ValidationItemFactory itemFactory;
    private final URI schemaUri;
    private final HttpClient httpClient;
    private final Duration requestTimeout;
    private final Duration loadTimeout;
    private final Duration retryDelay;

    private volatile @Nullable Schema cachedSchema;
    // Accessed only while holding this instance's monitor.
    private @Nullable SchemaLoadFailure cachedFailure;

    /** Uses bounded network requests and keeps a successful schema for the process lifetime. */
    @Autowired
    public EdmXsdValidator(ValidationItemFactory itemFactory) {
        this(itemFactory, URI.create(EDM_XSD_URL), Duration.ofSeconds(5),
                Duration.ofSeconds(10), Duration.ofSeconds(30), Duration.ofSeconds(30));
    }

    /** Allows local schema servers and short deadlines in regression tests. */
    EdmXsdValidator(ValidationItemFactory itemFactory, URI schemaUri, Duration connectTimeout,
                    Duration requestTimeout, Duration loadTimeout, Duration retryDelay) {
        this.itemFactory = itemFactory;
        this.schemaUri = schemaUri;
        this.httpClient = HttpClient.newBuilder().connectTimeout(connectTimeout)
                .followRedirects(HttpClient.Redirect.NORMAL).build();
        this.requestTimeout = requestTimeout;
        this.loadTimeout = loadTimeout;
        this.retryDelay = retryDelay;
    }

    /**
     * Warms the cache before the application accepts traffic.
     * An unavailable schema is reported without preventing the other engines from starting.
     */
    @PostConstruct
    public void preloadSchema() {
        try {
            getSchema();
            log.info("EDM-XSD samt importierten Schemas geladen und im Cache bereitgestellt");
        } catch (IllegalStateException ex) {
            // The other validation engines remain usable while Europeana is unavailable.
            log.warn("{}; erneuter Ladeversuch nach {} Sekunden bei der nächsten Validierung",
                    ex.getMessage(), retryDelay.toSeconds(), ex);
        }
    }

    /** Returns a document finding or a schema-availability error without aborting other checks. */
    public ValidationResultItem validateAgainstEdmXsd(byte[] rdfXmlBytes) {
        try {
            Validator validator = getSchema().newValidator();
            safeSetProperty(validator, XMLConstants.ACCESS_EXTERNAL_DTD, "");
            safeSetProperty(validator, XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            validator.validate(new StreamSource(new ByteArrayInputStream(rdfXmlBytes)));
            return itemFactory.success(ValidationSections.EDM_XSD, "EDM XSD", "EDM-XSD-Validierung erfolgreich", null, null);
        } catch (SAXParseException ex) {
            return itemFactory.failure(ValidationSections.EDM_XSD, "EDM XSD", ex.getMessage(), ex.getLineNumber(), ex.getColumnNumber(), rdfXmlBytes);
        } catch (SAXException ex) {
            return itemFactory.failure(ValidationSections.EDM_XSD, "EDM XSD", ex.getMessage(), null, null, rdfXmlBytes);
        } catch (Exception ex) {
            return itemFactory.failure(ValidationSections.EDM_XSD, "EDM XSD", ex.getMessage(), null, null, rdfXmlBytes);
        }
    }

    /** Serializes initial loading and retries; successful reads use the volatile cache directly. */
    private @NonNull Schema getSchema() {
        Schema current = cachedSchema;
        if (current != null) {
            return current;
        }

        synchronized (this) {
            current = cachedSchema;
            if (current != null) {
                return current;
            }
            SchemaLoadFailure failure = cachedFailure;
            if (failure != null && System.nanoTime() - failure.retryAfterNanos() < 0) {
                throw new IllegalStateException(failure.message());
            }
            try {
                Schema loaded = loadSchema(System.nanoTime() + loadTimeout.toNanos());
                cachedSchema = loaded;
                cachedFailure = null;
                return loaded;
            } catch (Exception ex) {
                String message = "EDM-XSD konnte nicht geladen werden (externe Schema-Ressource): " + ex.getMessage();
                cachedFailure = new SchemaLoadFailure(message, System.nanoTime() + retryDelay.toNanos());
                throw new IllegalStateException(message, ex);
            }
        }
    }

    /** Resolves every dependency through the same loader, with no unbounded JAXP URL fallback. */
    private @NonNull Schema loadSchema(long deadline) throws Exception {
        SchemaFactory schemaFactory = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
        schemaFactory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        safeSetProperty(schemaFactory, XMLConstants.ACCESS_EXTERNAL_DTD, "");
        safeSetProperty(schemaFactory, XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        if (!(DOMImplementationRegistry.newInstance().getDOMImplementation("LS") instanceof DOMImplementationLS dom)) {
            throw new IllegalStateException("Keine DOM Load/Save-Implementierung verfügbar");
        }
        schemaFactory.setResourceResolver((_, _, _, systemId, baseUri) -> {
            if (systemId == null || systemId.isBlank()) {
                return null;
            }
            URI resourceUri = (baseUri == null ? schemaUri : URI.create(baseUri)).resolve(systemId);
            SchemaResource resource = downloadSchema(resourceUri, deadline);
            LSInput input = dom.createLSInput();
            input.setSystemId(resource.uri().toString());
            input.setBaseURI(resource.uri().toString());
            input.setByteStream(new ByteArrayInputStream(resource.bytes()));
            return input;
        });
        SchemaResource resource = downloadSchema(schemaUri, deadline);
        StreamSource source = new StreamSource(new ByteArrayInputStream(resource.bytes()));
        source.setSystemId(resource.uri().toString());
        return Objects.requireNonNull(schemaFactory.newSchema(source));
    }

    /**
     * Downloads the entire response within the smaller of the request and shared load budgets.
     * The final URI is retained so relative imports also work after redirects.
     */
    private SchemaResource downloadSchema(URI uri, long deadline) {
        try {
            long remainingNanos = deadline - System.nanoTime();
            if (remainingNanos <= 0) {
                throw new HttpTimeoutException("Zeitlimit für das Laden des EDM-XSD samt Importen überschritten");
            }
            long timeoutNanos = Math.min(requestTimeout.toNanos(), remainingNanos);
            HttpRequest request = HttpRequest.newBuilder(uri)
                    .timeout(Duration.ofNanos(timeoutNanos))
                    .GET().build();
            var download = httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray());
            HttpResponse<byte[]> response;
            try {
                // HttpRequest.timeout alone does not cover a response body that stops arriving.
                response = download.get(Math.max(1, Math.min(timeoutNanos, deadline - System.nanoTime())),
                        TimeUnit.NANOSECONDS);
            } catch (TimeoutException ex) {
                throw new HttpTimeoutException("Zeitlimit beim Laden der Schema-Ressource überschritten");
            } catch (ExecutionException ex) {
                if (ex.getCause() instanceof IOException ioException) {
                    throw ioException;
                }
                throw new IOException("Schema-Abruf fehlgeschlagen", ex.getCause());
            } finally {
                if (!download.isDone()) {
                    download.cancel(true);
                }
            }
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new IOException("HTTP " + response.statusCode());
            }
            return new SchemaResource(response.body(), response.uri());
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Schema-Abruf unterbrochen: " + uri, ex);
        } catch (IOException ex) {
            throw new IllegalStateException("Schema-Abruf fehlgeschlagen: " + uri + ": " + ex.getMessage(), ex);
        }
    }

    private record SchemaLoadFailure(String message, long retryAfterNanos) {
    }

    private record SchemaResource(byte[] bytes, URI uri) {
    }

    private void safeSetProperty(Object target, String property, String value) {
        try {
            if (target instanceof SchemaFactory schemaFactory) {
                schemaFactory.setProperty(property, value);
            } else if (target instanceof Validator validator) {
                validator.setProperty(property, value);
            }
        } catch (Exception ignored) {
            // Runtime may not support all JAXP security properties.
        }
    }
}
