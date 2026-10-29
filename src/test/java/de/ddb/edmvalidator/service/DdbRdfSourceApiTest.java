package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.RdfSourceController;
import jakarta.json.Json;
import jakarta.json.JsonObject;
import org.junit.jupiter.api.Test;
import org.jspecify.annotations.NonNull;
import org.mockito.ArgumentCaptor;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.io.IOException;
import java.io.StringReader;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletionException;
import java.util.concurrent.Flow;

import static java.util.Objects.requireNonNull;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Tests real URL handling and bounded HTTP subscribers without making network requests. */
class DdbRdfSourceApiTest {
    private static final @NonNull Charset UTF_8 = requireNonNull(StandardCharsets.UTF_8);
    private static final String ITEM = "https://www.deutsche-digitale-bibliothek.de/item/ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    private static final String API = "https://api.deutsche-digitale-bibliothek.de/2/items/ABCDEFGHIJKLMNOPQRSTUVWXYZ123456/edm";

    @Test
    void loadReturnsTheEditableXmlFromOneFixedHostRequestAndPreservesTheProfile() throws Exception {
        String xml = "<?xml version=\"1.0\"?><source>Sammlung &amp; Überlieferung</source>";
        HttpClient client = transport(xml.getBytes(StandardCharsets.UTF_8), 200);
        JsonObject body = request(new DdbRdfSourceService(client), "  " + ITEM + "  ", true, 200);
        assertThat(body.getString("rdfXml")).isEqualTo(xml);
        assertThat(body.getString("ddbUri")).isEqualTo(ITEM);
        assertThat(body.getString("apiUrl")).isEqualTo(API);
        assertThat(body.isNull("error")).isTrue();
        ArgumentCaptor<HttpRequest> sent = ArgumentCaptor.forClass(HttpRequest.class);
        verify(client, times(1)).send(sent.capture(), any());
        assertThat(sent.getValue().uri().toString()).isEqualTo(API);
        assertThat(sent.getValue().headers().firstValue("accept-profile"))
                .contains(DdbConstants.EUROPEANA_EDM_PROFILE);
        assertThat(sent.getValue().timeout()).contains(Duration.ofSeconds(25));
    }

    @Test
    void invalidOrArbitraryDestinationsAreRejectedBeforeAnyHttpRequest() throws Exception {
        HttpClient client = mock(HttpClient.class);
        DdbRdfSourceService service = new DdbRdfSourceService(client);
        for (String url : List.of("", "https://example.org/item/ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
                "http://localhost/private", ITEM + "/more", ITEM + "?destination=http://localhost")) {
            JsonObject body = request(service, url, false, 400);
            assertThat(body.isNull("rdfXml")).isTrue();
            assertThat(body.getString("error")).contains("DDB-Item-URL");
        }
        verifyNoInteractions(client);
    }

    @Test
    void directTransportCallsAlsoRejectDestinationsOutsideTheFixedItemApi() {
        HttpClient client = mock(HttpClient.class);
        DdbRdfSourceService service = new DdbRdfSourceService(client);
        for (String destination : List.of("http://localhost/private", "https://example.org/edm", API + "?redirect=other",
                API + "#fragment", API.replace("/edm", "/metadata"))) {
            assertThrows(IllegalArgumentException.class, () -> service.load(destination, false));
            assertThrows(IllegalArgumentException.class, () -> service.loadForValidation(destination, false));
        }
        verifyNoInteractions(client);
    }

    @Test
    void editorDownloadIsBoundedWhileLegacyValidationKeepsItsExistingLimit() throws Exception {
        byte[] exact = new byte[RdfConversionService.MAX_INPUT_BYTES];
        JsonObject allowed = request(new DdbRdfSourceService(transport(exact, 200)), ITEM, false, 200);
        assertThat(allowed.isNull("error")).isTrue();

        byte[] oversized = new byte[RdfConversionService.MAX_INPUT_BYTES + 1];
        DdbRdfSourceService service = new DdbRdfSourceService(transport(oversized, 200));
        JsonObject rejected = request(service, ITEM, false, 502);
        assertThat(rejected.isNull("rdfXml")).isTrue();
        assertThat(rejected.getString("error")).contains("1 MiB");
        assertThat(service.loadForValidation(API, false)).hasSize(oversized.length);
    }

    @Test
    void upstreamErrorsReturnNoPartialDocument() throws Exception {
        for (int upstream : new int[]{302, 404, 503}) {
            JsonObject body = request(new DdbRdfSourceService(transport("<partial/>".getBytes(StandardCharsets.UTF_8), upstream)),
                    ITEM, false, 502);
            assertThat(body.isNull("rdfXml")).isTrue();
            assertThat(body.getString("error")).contains("HTTP " + upstream);
        }
        HttpClient failed = mock(HttpClient.class);
        when(failed.send(any(HttpRequest.class), any())).thenThrow(new IOException("Zeitlimit"));
        JsonObject body = request(new DdbRdfSourceService(failed), ITEM, false, 502);
        assertThat(body.getString("error")).contains("Zeitlimit");
    }

    private JsonObject request(DdbRdfSourceService service, String url, boolean profile, int expectedStatus) throws Exception {
        String input = Json.createObjectBuilder().add("ddbUri", url).add("europeanaProfile", profile).build().toString();
        String body = MockMvcBuilders.standaloneSetup(new RdfSourceController(service)).build()
                .perform(requireNonNull(post("/api/source").contentType(MediaType.APPLICATION_JSON).content(input)))
                .andExpect(status().is(expectedStatus)).andReturn().getResponse().getContentAsString(UTF_8);
        try (var reader = Json.createReader(new StringReader(body))) {
            return reader.readObject();
        }
    }

    /** Runs the supplied real body handler so its streaming size limit is exercised. */
    @SuppressWarnings("unchecked")
    private HttpClient transport(byte[] bytes, int status) throws Exception {
        HttpClient client = mock(HttpClient.class);
        when(client.send(any(HttpRequest.class), any())).thenAnswer(invocation -> {
            HttpResponse.BodyHandler<byte[]> handler = invocation.getArgument(1);
            HttpResponse.ResponseInfo info = mock(HttpResponse.ResponseInfo.class);
            when(info.statusCode()).thenReturn(status);
            HttpResponse.BodySubscriber<byte[]> subscriber = handler.apply(info);
            subscriber.onSubscribe(mock(Flow.Subscription.class));
            subscriber.onNext(List.of(ByteBuffer.wrap(bytes)));
            subscriber.onComplete();
            byte[] result;
            try {
                result = subscriber.getBody().toCompletableFuture().join();
            } catch (CompletionException ex) {
                throw new IOException(ex.getCause().getMessage(), ex.getCause());
            }
            HttpResponse<byte[]> response = mock(HttpResponse.class);
            when(response.statusCode()).thenReturn(status);
            when(response.body()).thenReturn(result);
            return response;
        });
        return client;
    }
}
