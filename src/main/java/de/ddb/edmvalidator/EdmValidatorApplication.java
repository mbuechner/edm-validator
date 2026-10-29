package de.ddb.edmvalidator;

import org.jspecify.annotations.NullMarked;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/** Starts the HTTP application and initializes the validation services. */
@NullMarked
@SpringBootApplication
public class EdmValidatorApplication {

    public static void main(String[] args) {
        SpringApplication.run(EdmValidatorApplication.class, args);
    }
}
