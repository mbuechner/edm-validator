package de.ddb.edmvalidator.api;

import de.ddb.edmvalidator.service.RdfConversionService;
import lombok.RequiredArgsConstructor;
import org.jspecify.annotations.NonNull;
import org.jspecify.annotations.NullMarked;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Parses and projects the local source without running validation engines or downloading it. */
@RestController
@RequestMapping("/api/graph")
@RequiredArgsConstructor
@NullMarked
public class GraphController {
    private final RdfConversionService service;

    @PostMapping
    public ResponseEntity<@NonNull GraphResponse> preview(@RequestBody GraphRequest request) {
        GraphResponse response = service.graphPreview(request);
        return response.error() == null ? ResponseEntity.ok(response) : ResponseEntity.badRequest().body(response);
    }
}
