package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;

/**
 * One requested output. Successful content is the exact UTF-8 document shared by
 * display, clipboard and download; failures carry an error and no content.
 */
@NullMarked
public record ConversionResult(
        String id,
        String fileName,
        String mediaType,
        @Nullable String content,
        long sizeBytes,
        @Nullable String error,
        boolean empty
) {
}
