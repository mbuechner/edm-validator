package de.ddb.edmvalidator.api;

import de.ddb.edmvalidator.service.DdbEdmValidationService;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
@Validated
public class ValidationController {

    private final DdbEdmValidationService validationService;

    public ValidationController(DdbEdmValidationService validationService) {
        this.validationService = validationService;
    }

    @PostMapping("/validate")
    public ResponseEntity<ValidationResponse> validate(@RequestBody ValidateRequest request) {
        ValidationResponse response = validationService.validate(request.ddbUri(), request.rdfXml(), Boolean.TRUE.equals(request.europeanaProfile()));
        return ResponseEntity.ok(response);
    }
}
