package de.ddb.edmvalidator.api;

/** Content is the final UTF-8 document, shared by display, clipboard and downloads. */
public record ConversionResult(
        String id,
        String fileName,
        String mediaType,
        String content,
        long sizeBytes,
        String error,
        boolean empty
) {
}
