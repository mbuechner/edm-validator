package de.ddb.edmvalidator.service;

import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * Downloads RDF/XML only from the fixed DDB item API. User-provided URLs are identifiers,
 * never arbitrary fetch destinations; redirects remain disabled. The editor download is
 * bounded while the existing validation endpoint keeps its previous download limit.
 */
@Service
@NullMarked
public class DdbRdfSourceService {
    private static final Pattern ITEM_URL = Objects.requireNonNull(Pattern.compile(DdbConstants.DDB_WEB_ITEM_PATTERN));
    private static final Pattern API_URL = Objects.requireNonNull(Pattern.compile(
            Pattern.quote(DdbConstants.DDB_API_ITEMS_BASE) + "[A-Z0-9]{32}/edm"));
    private final HttpClient httpClient;

    public DdbRdfSourceService() {
        this(Objects.requireNonNull(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(60)).build()));
    }

    /** Injects a transport for focused, network-free tests. */
    DdbRdfSourceService(HttpClient httpClient) {
        this.httpClient = httpClient;
    }

    /** Validates the public item URL before constructing its fixed-host API destination. */
    public String apiUrl(@Nullable String ddbUri) {
        var matcher = ITEM_URL.matcher(ddbUri == null ? "" : Objects.requireNonNull(ddbUri.trim()));
        if (!matcher.matches()) {
            throw new IllegalArgumentException("Ungültige DDB-Item-URL. Erwartetes Muster: "
                    + "https://www.deutsche-digitale-bibliothek.de/item/{ID}");
        }
        return DdbConstants.DDB_API_ITEMS_BASE + matcher.group(1) + "/edm";
    }

    /** Downloads at most the editor's 1 MiB limit without buffering an oversized response. */
    public byte[] load(String apiUrl, boolean europeanaProfile) {
        return download(apiUrl, europeanaProfile, RdfConversionService.MAX_INPUT_BYTES);
    }

    /** Reuses the transport without imposing a new limit on existing validation requests. */
    byte[] loadForValidation(String apiUrl, boolean europeanaProfile) {
        return download(apiUrl, europeanaProfile, 0);
    }

    private byte[] download(String apiUrl, boolean europeanaProfile, int maximumBytes) {
        if (!API_URL.matcher(apiUrl).matches()) {
            throw new IllegalArgumentException("Nur die feste DDB-Item-API darf als Downloadziel verwendet werden.");
        }
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(apiUrl))
                .timeout(Duration.ofSeconds(maximumBytes > 0 ? 25 : 120))
                .header("Accept", "application/rdf+xml, application/xml;q=0.9, */*;q=0.8")
                .header("User-Agent", "edm-validator/0.0.2");
        if (europeanaProfile) builder.header("accept-profile", DdbConstants.EUROPEANA_EDM_PROFILE);
        HttpResponse.BodyHandler<byte[]> handler = HttpResponse.BodyHandlers.ofByteArray();
        if (maximumBytes > 0) handler = HttpResponse.BodyHandlers.limiting(handler, maximumBytes);
        try {
            HttpResponse<byte[]> response = httpClient.send(builder.GET().build(), handler);
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new IllegalStateException("DDB API antwortete mit HTTP " + response.statusCode());
            }
            return Objects.requireNonNull(response.body());
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Fehler beim Download der RDF/XML-Ressource: " + ex.getMessage(), ex);
        } catch (IOException ex) {
            String limit = maximumBytes > 0 ? " (höchstens 1 MiB)" : "";
            throw new IllegalStateException("Fehler beim Download der RDF/XML-Ressource" + limit + ": " + ex.getMessage(), ex);
        }
    }
}
