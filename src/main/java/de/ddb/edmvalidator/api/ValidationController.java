package de.ddb.edmvalidator.api;

import de.ddb.edmvalidator.service.DdbEdmValidationService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Returns a complete validation response, including findings from individual engines. */
@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class ValidationController {

    private final DdbEdmValidationService validationService;

    /** Validates a DDB resource or pasted RDF/XML; reported violations are ordinary API results. */
    @PostMapping("/validate")
    public ResponseEntity<ValidationResponse> validate(@RequestBody ValidateRequest request) {
        ValidationResponse response = validationService.validate(request.ddbUri(), request.rdfXml(),
                Boolean.TRUE.equals(request.europeanaProfile()), request.documentIri());
        return ResponseEntity.ok(response);
    }
}
