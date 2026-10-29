package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.ConversionRequest;
import jakarta.json.Json;
import jakarta.json.JsonArray;
import jakarta.json.JsonObject;
import jakarta.json.JsonString;
import jakarta.json.JsonValue;
import org.apache.jena.atlas.lib.CharSpace;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.graph.Triple;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.riot.out.NodeFmtLib;
import org.apache.jena.riot.writer.NQuadsWriter;
import org.apache.jena.riot.writer.NTriplesWriter;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.vocabulary.RDF;
import org.jspecify.annotations.Nullable;

import java.io.ByteArrayOutputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import static java.util.Objects.requireNonNull;

/** RDF dataset writers share one canonical record identity without mutating or closing the source model. */
final class RdfRecordDump {
    private static final String ITEMS_BASE = "https://api.deutsche-digitale-bibliothek.de/items/";
    private static final Pattern RECORD = Pattern.compile("^https?://api\\.deutsche-digitale-bibliothek\\.de/(?:records|items)/([A-Z0-9]{32})$");
    private static final Pattern DOCUMENT = Pattern.compile("^https?://api\\.deutsche-digitale-bibliothek\\.de/(?:records|items)/([A-Z0-9]{32})(?:/(?:edm|source))?(?:[?#].*)?$");
    private static final Pattern ITEM = Pattern.compile("^https?://www\\.deutsche-digitale-bibliothek\\.de/(?:item|resource)/([A-Z0-9]{32})$");
    private static final Node PROVIDED_CHO = NodeFactory.createURI("http://www.europeana.eu/schemas/edm/ProvidedCHO");

    private final Model source;
    private final String graphIri;
    private final Node graph;
    private final String blankPrefix;
    private final Map<Node, Node> blankNodes = new HashMap<>();
    private final Set<String> scopedLabels = new HashSet<>();

    private RdfRecordDump(Model source, String graphIri) {
        this.source = source;
        this.graphIri = graphIri;
        graph = NodeFactory.createURI(graphIri);
        blankPrefix = "record_" + sha256(graphIri.getBytes(StandardCharsets.UTF_8)) + "_";
    }

    static RdfRecordDump create(Model source, ConversionRequest request, byte @Nullable [] upload) {
        Set<String> ids = new HashSet<>();
        var triples = source.getGraph().find();
        try {
            while (triples.hasNext()) {
                Triple triple = triples.next();
                addRecord(triple.getSubject(), ids);
                addRecord(triple.getObject(), ids);
                if (triple.getPredicate().equals(RDF.type.asNode()) && triple.getObject().equals(PROVIDED_CHO)
                        && triple.getSubject().isURI()) {
                    var match = ITEM.matcher(triple.getSubject().getURI());
                    if (match.matches()) {
                        ids.add(match.group(1));
                    }
                }
            }
        } finally { triples.close(); }
        String selected;
        if (ids.size() == 1) selected = ITEMS_BASE + ids.iterator().next();
        else {
            // A document identifies the record; an explicit base only controls RDF IRI resolution.
            selected = documentIdentity(request.documentIri());
            if (selected == null) selected = documentIdentity(request.baseIri());
            if (selected == null) selected = "urn:sha256:" + sha256(upload != null ? upload
                    : requireNonNull(request.rdfXml()).getBytes(StandardCharsets.UTF_8));
        }
        return new RdfRecordDump(source, selected);
    }

    String graphIri() { return graphIri; }

    /** Expanded JSON-LD represents this dataset as exactly one named graph, even when empty. */
    JsonArray namedGraph(JsonArray nodes) {
        return Json.createArrayBuilder().add(Json.createObjectBuilder()
                .add("@id", graphIri).add("@graph", nodes)).build();
    }

    /** Jena's native JSON-LD writer retains source blank labels, so reuse the native dump mapping. */
    JsonArray scopeSource(JsonArray nodes) { return (JsonArray) scopeJson(nodes, true); }

    /** Flattening/framing can issue new blank identifiers; these also need a record-specific scope. */
    JsonArray scopeProcessed(JsonArray nodes) { return (JsonArray) scopeJson(nodes, false); }

    private JsonValue scopeJson(JsonValue value, boolean sourceLabels) {
        if (value instanceof JsonArray array) {
            var result = Json.createArrayBuilder();
            array.forEach(item -> result.add(scopeJson(item, sourceLabels)));
            return result.build();
        }
        if (!(value instanceof JsonObject object) || object.containsKey("@value")) return value;
        var result = Json.createObjectBuilder();
        object.forEach((key, item) -> result.add(key, "@id".equals(key) || "@type".equals(key)
                ? scopeIdentifier(item, sourceLabels) : scopeJson(item, sourceLabels)));
        return result.build();
    }

    private JsonValue scopeIdentifier(JsonValue value, boolean sourceLabels) {
        if (value instanceof JsonArray array) {
            var result = Json.createArrayBuilder();
            array.forEach(item -> result.add(scopeIdentifier(item, sourceLabels)));
            return result.build();
        }
        if (!(value instanceof JsonString string) || !string.getString().startsWith("_:")) return value;
        String label = string.getString().substring(2);
        if (sourceLabels) return Json.createValue("_:" + scoped(NodeFactory.createBlankNode(label)).getBlankNodeLabel());
        if (scopedLabels.contains(label)) return value;
        // Processor-issued labels are document-local. Keep their scope disjoint from native labels.
        return Json.createValue("_:" + blankPrefix + "jsonld_" + sha256(label.getBytes(StandardCharsets.UTF_8)));
    }

    /** Each statement contains the same named graph; an empty graph has no N-Quads statements. */
    String nquads() {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        var triples = source.getGraph().find();
        try {
            NQuadsWriter.write(output, triples.mapWith(triple -> new Quad(graph, scoped(triple))), CharSpace.UTF8);
            return output.toString(StandardCharsets.UTF_8);
        } finally { triples.close(); }
    }

    /** One complete graph block per physical LF-terminated line, including an explicit empty block. */
    String trig() throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        output.writeBytes((NodeFmtLib.strNT(graph) + " {").getBytes(StandardCharsets.UTF_8));
        if (!source.isEmpty()) output.write(' ');
        var triples = source.getGraph().find();
        try {
            // Jena escapes literal line breaks before this stream sees native statement separators.
            NTriplesWriter.write(new StatementSeparators(output), triples.mapWith(this::scoped), CharSpace.UTF8);
            output.writeBytes("}\n".getBytes(StandardCharsets.UTF_8));
            return output.toString(StandardCharsets.UTF_8);
        } finally { triples.close(); }
    }

    private Triple scoped(Triple triple) {
        return Triple.create(scoped(triple.getSubject()), triple.getPredicate(), scoped(triple.getObject()));
    }

    private Node scoped(Node node) {
        return node.isBlank() ? blankNodes.computeIfAbsent(node, _ -> {
            String label = blankPrefix + blankNodes.size();
            scopedLabels.add(label);
            return NodeFactory.createBlankNode(label);
        }) : node;
    }

    private static void addRecord(Node node, Set<String> ids) {
        if (!node.isURI()) return;
        var match = RECORD.matcher(node.getURI());
        if (match.matches()) {
            ids.add(match.group(1));
        }
    }

    private static @Nullable String documentIdentity(@Nullable String value) {
        String iri = absolute(value);
        if (iri == null) return null;
        var document = DOCUMENT.matcher(iri);
        if (document.matches()) return ITEMS_BASE + document.group(1);
        var item = ITEM.matcher(iri);
        return item.matches() ? ITEMS_BASE + item.group(1) : iri;
    }

    private static @Nullable String absolute(@Nullable String value) {
        if (value == null || value.isBlank()) return null;
        try { return RdfInputIri.absolute(value, false); }
        catch (IllegalArgumentException ignored) { return null; }
    }

    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException ex) { throw new IllegalStateException("SHA-256 ist nicht verfügbar.", ex); }
    }

    /** Replaces only the LF bytes emitted between native N-Triples statements, without buffering lines. */
    private static final class StatementSeparators extends FilterOutputStream {
        private StatementSeparators(OutputStream output) { super(output); }

        @Override public void write(int value) throws IOException { out.write(value == '\n' ? ' ' : value); }

        @Override public void write(byte[] bytes, int offset, int length) throws IOException {
            int start = offset;
            int end = offset + length;
            for (int index = offset; index < end; index++) {
                if (bytes[index] != '\n') continue;
                out.write(bytes, start, index - start);
                out.write(' ');
                start = index + 1;
            }
            out.write(bytes, start, end - start);
        }
    }
}
