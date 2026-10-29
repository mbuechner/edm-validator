package de.ddb.edmvalidator.api;

import org.jspecify.annotations.NullMarked;
import org.jspecify.annotations.Nullable;

import java.util.List;

/** A bounded graph preview; malformed input returns empty collections and an error. */
@NullMarked
public record GraphResponse(List<RdfGraphNode> graphNodes, List<RdfGraphLink> graphLinks,
                            @Nullable String error) {
}
