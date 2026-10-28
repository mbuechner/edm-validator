package de.ddb.edmvalidator.api;

import de.ddb.edmvalidator.service.RdfConversionService;
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

@RestController
@RequestMapping("/api/convert")
public class ConversionController {
    private final RdfConversionService service;
    private final JsonMapper jsonMapper;

    public ConversionController(RdfConversionService service, JsonMapper jsonMapper) {
        this.service = service;
        this.jsonMapper = jsonMapper;
    }

    @PostMapping
    public ConversionResponse convert(@RequestBody ConversionRequest request) {
        return service.convert(request);
    }

    @PostMapping("/inspect")
    public ConversionResponse inspect(@RequestBody ConversionRequest request) {
        return service.inspect(request);
    }

    @PostMapping(value = "/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<ConversionResponse> upload(@RequestParam("file") MultipartFile file,
                                                     @RequestParam(value = "options", defaultValue = "{}") String options) throws IOException {
        if (file.getSize() > RdfConversionService.MAX_INPUT_BYTES) {
            return error(HttpStatus.CONTENT_TOO_LARGE, "rdfXml", "RDF/XML darf höchstens 1 MiB groß sein.");
        }
        ConversionRequest request;
        try {
            if (options.length() > RdfConversionService.MAX_INPUT_BYTES) throw new IllegalArgumentException();
            request = jsonMapper.readValue(options, ConversionRequest.class);
            if (request == null) throw new IllegalArgumentException();
        } catch (Exception ex) {
            return error(HttpStatus.BAD_REQUEST, "outputs", "Die Konvertierungseinstellungen sind kein gültiges JSON-Objekt.");
        }
        return ResponseEntity.ok(service.convert(request, file.getBytes()));
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<ConversionResponse> tooLarge() {
        return error(HttpStatus.CONTENT_TOO_LARGE, "rdfXml", "RDF/XML darf höchstens 1 MiB groß sein.");
    }

    private ResponseEntity<ConversionResponse> error(HttpStatus status, String field, String message) {
        return ResponseEntity.status(status).body(new ConversionResponse(List.of(), List.of(new ConversionIssue(field, message)), null, null, List.of(), null));
    }
}
