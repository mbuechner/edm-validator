package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;

/**
 * One requested output. Text content is the exact UTF-8 document shared by display,
 * clipboard and download; binary Jelly content uses {@code contentEncoding=base64}.
 * Both sizes describe the actual file bytes, before Base64 transport encoding.
 * Dataset formats expose their automatically selected record graph IRI.
 */
@NullMarked
public record ConversionResult(
        String id,
        String fileName,
        String mediaType,
        @Nullable String content,
        long sizeBytes,
        @Nullable String error,
        boolean empty,
        @Nullable String graphIri,
        long gzipSizeBytes,
        @Nullable String contentEncoding
) {
}
