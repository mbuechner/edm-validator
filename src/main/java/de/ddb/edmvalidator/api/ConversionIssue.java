package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;

/** A user-facing error associated with an input or output option. */
@NullMarked
public record ConversionIssue(String field, String message) {
}
