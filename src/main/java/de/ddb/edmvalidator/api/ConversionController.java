package de.ddb.edmvalidator.api;

import de.ddb.edmvalidator.service.RdfConversionService;
import lombok.RequiredArgsConstructor;
import org.jspecify.annotations.NonNull;
import org.jspecify.annotations.NullMarked;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartFile;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.util.List;

import static java.util.Objects.requireNonNull;

/** Exposes conversion, metadata inspection and byte-preserving RDF/XML uploads. */
@RestController
@RequestMapping("/api/convert")
@RequiredArgsConstructor
@NullMarked
public class ConversionController {
    private final RdfConversionService service;
    private final JsonMapper jsonMapper;

    /** Converts pasted RDF/XML using the requested output formats and options. */
    @PostMapping
    public ConversionResponse convert(@RequestBody ConversionRequest request) {
        return service.convert(request);
    }

    /** Inspects the graph for editor suggestions without producing output documents. */
    @PostMapping("/inspect")
    public ConversionResponse inspect(@RequestBody ConversionRequest request) {
        return service.inspect(request);
    }

    /**
     * Converts upload bytes without decoding them before the XML parser reads their encoding.
     * Invalid options and oversized uploads produce field-specific error responses.
     */
    @PostMapping(value = "/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<@NonNull ConversionResponse> upload(@RequestParam("file") MultipartFile file,
                                                     @RequestParam(value = "options", defaultValue = "{}") String options) throws IOException {
        if (file.getSize() > RdfConversionService.MAX_INPUT_BYTES) {
            return error(HttpStatus.CONTENT_TOO_LARGE, "rdfXml", "RDF/XML darf höchstens 1 MiB groß sein.");
        }
        ConversionRequest request;
        try {
            if (options.length() > RdfConversionService.MAX_INPUT_BYTES) throw new IllegalArgumentException();
            var node = requireNonNull(jsonMapper.readTree(options));
            if (!node.isObject()) throw new IllegalArgumentException();
            request = requireNonNull(jsonMapper.treeToValue(node, ConversionRequest.class));
        } catch (Exception ex) {
            return error(HttpStatus.BAD_REQUEST, "outputs", "Die Konvertierungseinstellungen sind kein gültiges JSON-Objekt.");
        }
        return ResponseEntity.ok(service.convert(request, file.getBytes()));
    }

    /** Uses the same field-level error format when the servlet upload limit rejects a file. */
    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<@NonNull ConversionResponse> tooLarge() {
        return error(HttpStatus.CONTENT_TOO_LARGE, "rdfXml", "RDF/XML darf höchstens 1 MiB groß sein.");
    }

    private ResponseEntity<@NonNull ConversionResponse> error(HttpStatus status, String field, String message) {
        return ResponseEntity.status(status).body(new ConversionResponse(
                requireNonNull(List.of()), requireNonNull(List.of(new ConversionIssue(field, message))),
                null, null, requireNonNull(List.of()), null));
    }
}
