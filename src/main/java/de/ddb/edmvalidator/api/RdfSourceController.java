package de.ddb.edmvalidator.api;

import de.ddb.edmvalidator.service.DdbRdfSourceService;
import lombok.RequiredArgsConstructor;
import org.jspecify.annotations.NonNull;
import org.jspecify.annotations.NullMarked;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.util.Objects;

/** Loads an editable source independently of validation, graph inspection or conversion. */
@RestController
@RequestMapping("/api/source")
@RequiredArgsConstructor
@NullMarked
public class RdfSourceController {
    private final DdbRdfSourceService service;

    @PostMapping
    public ResponseEntity<@NonNull RdfSourceResponse> load(@RequestBody RdfSourceRequest request) {
        String rawDdbUri = request.ddbUri();
        String ddbUri = rawDdbUri == null ? "" : Objects.requireNonNull(rawDdbUri.trim());
        String apiUrl;
        try {
            apiUrl = service.apiUrl(ddbUri);
        } catch (IllegalArgumentException ex) {
            return ResponseEntity.badRequest().body(new RdfSourceResponse(ddbUri, null, null, ex.getMessage()));
        }
        try {
            String xml = new String(service.load(apiUrl, Boolean.TRUE.equals(request.europeanaProfile())), StandardCharsets.UTF_8);
            return ResponseEntity.ok(new RdfSourceResponse(ddbUri, apiUrl, xml, null));
        } catch (IllegalStateException ex) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                    .body(new RdfSourceResponse(ddbUri, apiUrl, null, ex.getMessage()));
        }
    }
}
