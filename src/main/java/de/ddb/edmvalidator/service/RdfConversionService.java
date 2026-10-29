package de.ddb.edmvalidator.service;

import com.apicatalog.jsonld.JsonLd;
import com.apicatalog.jsonld.JsonLdError;
import com.apicatalog.jsonld.JsonLdErrorCode;
import com.apicatalog.jsonld.JsonLdOptions;
import com.apicatalog.jsonld.JsonLdVersion;
import com.apicatalog.jsonld.document.JsonDocument;
import com.apicatalog.jsonld.loader.DocumentLoader;
import de.ddb.edmvalidator.api.ConversionIssue;
import de.ddb.edmvalidator.api.ConversionRequest;
import de.ddb.edmvalidator.api.ConversionResponse;
import de.ddb.edmvalidator.api.ConversionResult;
import de.ddb.edmvalidator.api.GraphRequest;
import de.ddb.edmvalidator.api.GraphResponse;
import jakarta.json.Json;
import jakarta.json.JsonArray;
import jakarta.json.JsonObject;
import jakarta.json.JsonObjectBuilder;
import jakarta.json.JsonString;
import jakarta.json.JsonStructure;
import jakarta.json.JsonValue;
import jakarta.json.stream.JsonGenerator;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFDataMgr;
import org.apache.jena.riot.RDFFormat;
import org.apache.jena.riot.RDFParser;
import org.apache.jena.riot.RDFWriter;
import org.apache.jena.riot.SysRIOT;
import org.apache.jena.riot.system.ErrorHandlerFactory;
import org.apache.jena.util.SplitIRI;
import org.jspecify.annotations.NonNull;
import org.jspecify.annotations.Nullable;
import org.springframework.stereotype.Service;
import org.w3c.dom.Element;
import org.w3c.dom.Document;
import org.w3c.dom.Node;
import org.xml.sax.InputSource;
import org.xml.sax.SAXParseException;
import org.xml.sax.helpers.DefaultHandler;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.Serial;
import java.io.StringReader;
import java.io.StringWriter;
import java.io.UncheckedIOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Converts one RDF graph into independent RDF/XML and JSON-LD outputs.
 *
 * <p>Instances are stateless: every call owns and closes its Jena model. Input IRIs
 * are identifiers, never download locations; JSON-LD contexts must be embedded.
 * An output-specific failure leaves unrelated requested formats available.
 *
 * <p>The browser uses {@code contextMode=generated}: every output and custom frame
 * uses the namespace context generated from the current RDF source. Root frame
 * contexts are replaced and scoped frame contexts are rejected. Legacy API modes
 * {@code auto} and {@code custom} retain their independent custom-frame contexts.
 */
@Service
public class RdfConversionService {
    public static final int MAX_INPUT_BYTES = 1024 * 1024;
    private static final String RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
    // Reserved RDF/XML names cannot encode an implicit rdf:type statement.
    private static final Set<String> RESERVED_NODE_NAMES = Set.of("RDF", "Description", "ID", "about",
            "parseType", "resource", "nodeID", "datatype", "li", "aboutEach", "aboutEachPrefix", "bagID");
    private static final List<@NonNull String> METHODS = List.of("expanded", "compacted", "flattened", "framed");
    private static final DocumentLoader LOCAL_ONLY = (_, _) -> {
        throw new JsonLdError(JsonLdErrorCode.LOADING_REMOTE_CONTEXT_FAILED,
                "Externe JSON-LD-Kontexte werden nicht geladen. Bitte einen eingebetteten Kontext verwenden.");
    };

    /** Converts pasted RDF/XML; a missing request produces a field-level input error. */
    public @NonNull ConversionResponse convert(@Nullable ConversionRequest request) {
        return process(request, null, false);
    }

    /** Upload bytes remain bytes so the XML declaration/BOM determines the source encoding. */
    public @NonNull ConversionResponse convert(@Nullable ConversionRequest request, byte @Nullable [] upload) {
        return process(request, upload, false);
    }

    /** Parses the source for context and resource metadata without serializing output files. */
    public @NonNull ConversionResponse inspect(@Nullable ConversionRequest request) {
        return process(request, null, true);
    }

    /** Uses the conversion parser and its local-only XML/IRI rules for an independent graph preview. */
    public @NonNull GraphResponse graphPreview(GraphRequest request) {
        ConversionRequest source = new ConversionRequest(request.rdfXml(), null, request.documentIri(),
                null, null, null, null, null, null, null, null, null, null, null, null);
        Model model = ModelFactory.createDefaultModel();
        try {
            parse(source, null, model);
            return RdfGraphPreviewBuilder.build(model);
        } catch (Exception ex) {
            return new GraphResponse(Objects.requireNonNull(List.of()), Objects.requireNonNull(List.of()),
                    "Ungültiges RDF/XML: " + message(ex));
        } finally {
            model.close();
        }
    }

    private @NonNull ConversionResponse process(@Nullable ConversionRequest request, byte @Nullable [] upload, boolean inspect) {
        List<@NonNull ConversionIssue> issues = new ArrayList<>();
        List<ConversionResult> results = new ArrayList<>();
        if (request == null) return failure("rdfXml", "Bitte RDF/XML eingeben oder eine Datei hochladen.");
        List<@Nullable String> requestedMethods = request.methods();
        List<@Nullable String> methods = requestedMethods == null ? List.of("compacted") : requestedMethods;
        boolean xml = !Boolean.FALSE.equals(request.rdfXmlOutput());
        boolean jsonld = !Boolean.FALSE.equals(request.jsonLdOutput());
        boolean compactFlattening = "compacted".equals(request.representation());
        if (!inspect) {
            if (!xml && !jsonld) issues.add(new ConversionIssue("outputs", "Bitte mindestens ein Ausgabeformat auswählen."));
            if (jsonld && (methods.isEmpty() || methods.stream().anyMatch(m -> m == null || !METHODS.contains(m)))) {
                issues.add(new ConversionIssue("methods", "Bitte mindestens ein gültiges JSON-LD-Verfahren auswählen."));
            }
            if (jsonld && request.representation() != null
                    && !List.of("compacted", "expanded").contains(request.representation())) {
                issues.add(new ConversionIssue("representation", "Bitte die JSON-LD-Darstellung kompakt oder expandiert auswählen."));
            }
            if (!issues.isEmpty()) return response(results, issues, null, null, List.of());
        }

        Model model = ModelFactory.createDefaultModel();
        try {
            parse(request, upload, model);
        } catch (ConversionInputException ex) {
            model.close();
            return failure(ex.field, message(ex));
        } catch (Exception ex) {
            model.close();
            return failure("rdfXml", "Ungültiges RDF/XML: " + message(ex));
        }

        try {
            JsonObject autoContext = automaticContext(model);
            String autoContextText = pretty(autoContext);
            List<String> resources = resources(model);
            JsonObject selectedContext = autoContext;
            String contextError = null;
            boolean needsContext = jsonld && (methods.contains("compacted")
                    || (methods.contains("flattened") && compactFlattening)
                    || (methods.contains("framed") && !("custom".equals(request.frameMode()) && hasOwnContext(request.frame()))));
            if (needsContext && "custom".equals(request.contextMode())) {
                try {
                    selectedContext = contextDocument(request.context());
                    // Processing validates term definitions as well as JSON syntax, even for an empty graph.
                    JsonLd.expand(JsonDocument.of(Json.createObjectBuilder().build()))
                            .context(JsonDocument.of(selectedContext)).options(options()).get();
                } catch (Exception ex) {
                    contextError = "Ungültiger Kontext: " + message(ex);
                    issues.add(new ConversionIssue("context", contextError));
                }
            }

            JsonObject effectiveFrame = null;
            String frameError = null;
            if (jsonld && methods.contains("framed")) {
                try {
                    effectiveFrame = frameDocument(request, selectedContext, contextError);
                } catch (Exception ex) {
                    frameError = "Ungültiges Frame: " + message(ex);
                    issues.add(new ConversionIssue("frame", frameError));
                }
            }
            String frameText = effectiveFrame == null ? null : pretty(effectiveFrame);
            if (inspect) return response(results, issues, autoContextText, frameText, resources);

            if (xml) {
                List<@NonNull ConversionIssue> xmlErrors = xmlOptionsErrors(request);
                if (!xmlErrors.isEmpty()) {
                    issues.addAll(xmlErrors);
                    results.add(failed("rdfxml", "converted.rdf", "application/rdf+xml",
                            String.join(" ", xmlErrors.stream().map(ConversionIssue::message).toList())));
                } else {
                    try {
                        results.add(success("rdfxml", "converted.rdf", "application/rdf+xml", writeXml(model, request), false));
                    } catch (Exception ex) {
                        results.add(failed("rdfxml", "converted.rdf", "application/rdf+xml",
                                "RDF/XML konnte nicht geschrieben werden: " + RdfXmlWriteDiagnostics.describe(ex, model)));
                    }
                }
            }
            if (!jsonld) return response(results, issues, autoContextText, frameText, resources);

            JsonDocument source;
            try {
                // Jena's plain JSON-LD writer preserves lexical literal forms and
                // supplies the same complete graph to every independent operation.
                source = JsonDocument.of(new StringReader(serialize(model, RDFFormat.JSONLD11_PLAIN)));
            } catch (Exception ex) {
                for (@NonNull String method : METHODS) if (methods.contains(method)) {
                    results.add(failed(method, fileName(method, request.representation()), "application/ld+json", "JSON-LD konnte nicht erzeugt werden: " + message(ex)));
                }
                return response(results, issues, autoContextText, frameText, resources);
            }

            for (@NonNull String method : METHODS) {
                if (!methods.contains(method)) continue;
                try {
                    JsonStructure output;
                    switch (method) {
                        case "expanded" -> output = JsonLd.expand(source).options(options()).get();
                        case "compacted" -> {
                            if (contextError != null) throw new IllegalArgumentException(contextError);
                            output = JsonLd.compact(source, JsonDocument.of(selectedContext)).options(options()).get();
                        }
                        case "flattened" -> {
                            var flatten = JsonLd.flatten(source).options(options());
                            if (compactFlattening) {
                                if (contextError != null) throw new IllegalArgumentException(contextError);
                                flatten.context(JsonDocument.of(selectedContext));
                            }
                            output = flatten.get();
                        }
                        case "framed" -> {
                            if (frameError != null) throw new IllegalArgumentException(frameError);
                            output = JsonLd.frame(source, JsonDocument.of(Objects.requireNonNull(effectiveFrame,
                                    "A successful frame configuration must supply a frame"))).options(options()).get();
                            if ("expanded".equals(request.representation())) {
                                // Expansion changes terms and values, while keeping the frame's
                                // finite nesting and selected view of the graph intact.
                                output = JsonLd.expand(JsonDocument.of(output)).options(options()).get();
                            }
                        }
                        default -> throw new IllegalArgumentException("Unbekanntes JSON-LD-Verfahren.");
                    }
                    results.add(success(method, fileName(method, request.representation()), "application/ld+json", pretty(output), "framed".equals(method) && emptyFrame(output)));
                } catch (Exception ex) {
                    String error = "JSON-LD (" + method + "): " + message(ex);
                    results.add(failed(method, fileName(method, request.representation()), "application/ld+json", error));
                    if ("framed".equals(method) && frameError == null) issues.add(new ConversionIssue("frame", error));
                    if (("compacted".equals(method) || ("flattened".equals(method) && compactFlattening)) && contextError == null) {
                        issues.add(new ConversionIssue("context", error));
                    }
                }
            }
            return response(results, issues, autoContextText, frameText, resources);
        } finally {
            model.close();
        }
    }

    private void parse(ConversionRequest request, byte @Nullable [] upload, Model model) throws Exception {
        String input = request.rdfXml();
        if (upload == null && !nonblank(input)) {
            throw new ConversionInputException("rdfXml", "Bitte RDF/XML eingeben oder eine Datei hochladen.");
        }
        // A text source is required only when there is no upload; keep that invariant local.
        byte[] bytes = upload == null ? Objects.requireNonNull(input).getBytes(StandardCharsets.UTF_8) : upload;
        int size = bytes.length;
        if (size == 0) throw new ConversionInputException("rdfXml", "Die RDF/XML-Datei ist leer.");
        if (size > MAX_INPUT_BYTES) throw new ConversionInputException("rdfXml", "RDF/XML darf höchstens 1 MiB groß sein.");
        String base = nonblank(request.baseIri()) ? absoluteIri(request.baseIri(), "Basis-IRI")
                : nonblank(request.documentIri()) ? absoluteIri(request.documentIri(), "Dokument-IRI") : null;

        InputSource secureInput = upload == null ? new InputSource(new StringReader(Objects.requireNonNull(input)))
                : new InputSource(new ByteArrayInputStream(upload));
        Element root = readXml(secureInput).getDocumentElement();
        checkBases(root, base == null ? null : URI.create(base));

        var parser = RDFParser.create().lang(Lang.RDFXML).strict(true)
                .errorHandler(ErrorHandlerFactory.errorHandlerStrict);
        if (base != null) parser.base(base);
        if (upload == null) parser.source(new StringReader(Objects.requireNonNull(input)));
        else parser.source(new ByteArrayInputStream(upload));
        parser.parse(model);
    }

    private Document readXml(InputSource input) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        var builder = factory.newDocumentBuilder();
        builder.setEntityResolver((_, _) -> { throw new org.xml.sax.SAXException("Externe Entitäten sind nicht erlaubt."); });
        builder.setErrorHandler(new DefaultHandler() {
            @Override public void error(SAXParseException e) throws SAXParseException { throw e; }
            @Override public void fatalError(SAXParseException e) throws SAXParseException { throw e; }
        });
        return builder.parse(input);
    }

    /** Reject ambiguous identifiers before Jena could supply a process working-directory base. */
    private void checkBases(Element element, @Nullable URI inheritedBase) throws ConversionInputException {
        URI base = inheritedBase;
        if (element.hasAttributeNS(XMLConstants.XML_NS_URI, "base")) {
            String value = element.getAttributeNS(XMLConstants.XML_NS_URI, "base");
            try {
                URI own = URI.create(value);
                base = own.isAbsolute() ? own : inheritedBase == null ? own : inheritedBase.resolve(own);
            } catch (IllegalArgumentException ex) {
                throw new ConversionInputException("baseIri", "Ungültiges xml:base. Bitte eine gültige Basis-IRI verwenden.");
            }
        }
        for (String attr : List.of("about", "resource", "datatype", "ID")) {
            if (!element.hasAttributeNS(RDF_NS, attr)) continue;
            String value = element.getAttributeNS(RDF_NS, attr);
            boolean relative;
            try {
                relative = "ID".equals(attr) || !URI.create(value).isAbsolute();
            } catch (IllegalArgumentException ex) {
                // Jena supplies the detailed RDF syntax error for malformed identifiers.
                continue;
            }
            if (relative && (base == null || !base.isAbsolute() || base.isOpaque())) {
                throw new ConversionInputException("baseIri", "Relative IRIs benötigen eine absolute Basis-IRI, eine bekannte Dokument-IRI oder ein geeignetes xml:base.");
            }
        }
        // RDF attributes inside an XML literal are literal markup, not RDF identifiers.
        if ("Literal".equals(element.getAttributeNS(RDF_NS, "parseType"))) return;
        for (Node child = element.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (child instanceof Element nested) checkBases(nested, base);
        }
    }

    private JsonObject automaticContext(Model model) {
        JsonObjectBuilder prefixes = Json.createObjectBuilder();
        for (var entry : new TreeMap<>(model.getNsPrefixMap()).entrySet()) {
            if (entry.getKey().isEmpty()) prefixes.add("@vocab", entry.getValue());
            else prefixes.add(entry.getKey(), Json.createObjectBuilder().add("@id", entry.getValue()).add("@prefix", true));
        }
        return Json.createObjectBuilder().add("@context", prefixes).build();
    }

    private List<String> resources(Model model) {
        Set<String> result = new HashSet<>();
        var statements = model.listStatements();
        try {
            statements.forEachRemaining(s -> {
                if (s.getSubject().isURIResource()) result.add(s.getSubject().getURI());
                if (s.getObject().isURIResource()) result.add(s.getResource().getURI());
            });
        } finally { statements.close(); }
        return result.stream().sorted().toList();
    }

    private JsonObject contextDocument(@Nullable String content) {
        JsonObject document = jsonObject(content, "Ein JSON-Dokument mit oberster @context-Eigenschaft ist erforderlich.");
        if (!document.containsKey("@context")) throw new IllegalArgumentException("Das JSON-Dokument benötigt eine oberste @context-Eigenschaft.");
        checkLocalContexts(document);
        return Json.createObjectBuilder().add("@context", document.get("@context")).build();
    }

    private boolean hasOwnContext(@Nullable String frame) {
        try { return jsonObject(frame, "Das Frame muss ein JSON-Objekt sein.").containsKey("@context"); }
        catch (IllegalArgumentException ex) { return false; }
    }

    private JsonObject frameDocument(ConversionRequest request, JsonObject selectedContext, @Nullable String contextError) throws ConversionInputException {
        JsonObjectBuilder frame;
        boolean custom = "custom".equals(request.frameMode());
        if (custom) {
            JsonObject own = jsonObject(request.frame(), "Das Frame muss ein JSON-Objekt sein.");
            if ("generated".equals(request.contextMode())) {
                // The root context is presentation metadata supplied by this mode. A nested
                // context could change a frame rule's meaning, so reject it instead of removing it.
                own = Json.createObjectBuilder(own).remove("@context").build();
                rejectScopedFrameContexts(own);
            }
            checkLocalContexts(own);
            frame = Json.createObjectBuilder(own);
            if (!own.containsKey("@context")) {
                if (contextError != null) throw new IllegalArgumentException(contextError);
                frame.add("@context", selectedContext.get("@context"));
            }
        } else {
            if (contextError != null) throw new IllegalArgumentException(contextError);
            String root = absoluteIri(request.rootIri(), "Wurzelressource");
            String requestedEmbed = request.embed();
            String embed = requestedEmbed != null && !requestedEmbed.isBlank() ? requestedEmbed : "@once";
            if (!embed.startsWith("@")) embed = "@" + embed;
            if (!List.of("@once", "@always", "@never").contains(embed)) throw new IllegalArgumentException("Bitte eine gültige Einbettungsvorgabe auswählen.");
            frame = Json.createObjectBuilder().add("@context", selectedContext.get("@context")).add("@id", root).add("@embed", embed);
        }
        return frame.build();
    }

    /** Keeps every custom-frame rule in the source-generated namespace context. */
    private void rejectScopedFrameContexts(JsonValue value) {
        if (value instanceof JsonObject object) {
            if (object.containsKey("@context")) {
                throw new IllegalArgumentException("Verschachtelte @context-Einträge im Frame sind nicht erlaubt; "
                        + "der Kontext wird automatisch aus dem RDF/XML erzeugt.");
            }
            object.values().forEach(this::rejectScopedFrameContexts);
        } else if (value instanceof JsonArray array) array.forEach(this::rejectScopedFrameContexts);
    }

    /** Reject remote context URLs and @import at every nested/scoped context location. */
    private void checkLocalContexts(JsonValue value) {
        if (value instanceof JsonObject object) {
            if (object.containsKey("@import")) throw new IllegalArgumentException("Externe JSON-LD-Kontexte (@import) sind nicht erlaubt; bitte den Kontext einbetten.");
            if (object.containsKey("@context")) checkContextValue(object.get("@context"));
            object.values().forEach(this::checkLocalContexts);
        } else if (value instanceof JsonArray array) array.forEach(this::checkLocalContexts);
    }

    private void checkContextValue(JsonValue context) {
        if (context instanceof JsonString) throw new IllegalArgumentException("Externe JSON-LD-Kontexte werden nicht geladen; bitte ein eingebettetes @context-Objekt verwenden.");
        if (context instanceof JsonArray array) array.forEach(this::checkContextValue);
    }

    private JsonObject jsonObject(@Nullable String text, String required) {
        if (text == null || text.isBlank()) throw new IllegalArgumentException(required);
        if (text.getBytes(StandardCharsets.UTF_8).length > MAX_INPUT_BYTES) throw new IllegalArgumentException("JSON darf höchstens 1 MiB groß sein.");
        try (var reader = Json.createReader(new StringReader(text))) {
            return reader.readObject();
        } catch (Exception ex) {
            throw new IllegalArgumentException(required + " " + message(ex));
        }
    }

    private JsonLdOptions options() {
        JsonLdOptions options = new JsonLdOptions(LOCAL_ONLY);
        options.setProcessingMode(JsonLdVersion.V1_1);
        options.setCompactToRelative(false);
        options.setUseNativeTypes(false);
        options.setOmitGraph(false);
        options.setOrdered(true);
        options.setTimeout(Duration.ofSeconds(30));
        return options;
    }

    private String absoluteIri(@Nullable String value, String label) throws ConversionInputException {
        try {
            if (value == null || value.isBlank()) throw new IllegalArgumentException();
            return RdfInputIri.absolute(value, "Basis-IRI".equals(label));
        } catch (IllegalArgumentException ex) {
            throw new ConversionInputException("baseIri", label + " muss eine gültige absolute IRI sein" + ("Basis-IRI".equals(label) ? " (ohne Fragment)." : "."));
        }
    }

    private String serialize(Model model, RDFFormat format) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        RDFDataMgr.write(out, model, format);
        return out.toString(StandardCharsets.UTF_8);
    }

    private List<@NonNull ConversionIssue> xmlOptionsErrors(ConversionRequest request) {
        List<@NonNull ConversionIssue> errors = new ArrayList<>();
        if (request.xmlRepresentation() != null && !List.of("explicit", "typed").contains(request.xmlRepresentation())) {
            errors.add(new ConversionIssue("xmlRepresentation", "Bitte für XML typisierte Elemente oder explizites rdf:type auswählen."));
        }
        if (request.xmlStructure() != null && !List.of("flat", "nested").contains(request.xmlStructure())) {
            errors.add(new ConversionIssue("xmlStructure", "Bitte für XML flache oder verschachtelte Struktur auswählen."));
        }
        return errors;
    }

    private String writeXml(Model model, ConversionRequest request) throws Exception {
        boolean nested = "nested".equals(request.xmlStructure());
        boolean typed = !"explicit".equals(request.xmlRepresentation());
        RDFFormat format = nested ? RDFFormat.RDFXML_PRETTY : RDFFormat.RDFXML_PLAIN;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        // Jena controls indentation without touching whitespace inside literals or XML literals.
        // Without a writer base, resource IRIs remain independent of the download location.
        boolean rewrite = typed != nested;
        // During the XML transformation, XMLLiteral values remain escaped text, so
        // a serializer cannot change their namespace bindings or lexical contents.
        Map<String, Object> properties = rewrite
                ? Map.of("tab", 2, "blockRules", nested ? "propertyAttr,parseTypeLiteralPropertyElt" : "parseTypeLiteralPropertyElt")
                : Map.of("tab", 2);
        RDFWriter.create().source(model).format(format).set(SysRIOT.sysRdfWriterProperties, properties).output(out);
        if (!rewrite) return out.toString(StandardCharsets.UTF_8);

        Document document = readXml(new InputSource(new ByteArrayInputStream(out.toByteArray())));
        for (Node child = document.getDocumentElement().getFirstChild(), next; child != null; child = next) {
            next = child.getNextSibling();
            if (child instanceof Element element) rewriteXmlNode(element, typed);
        }
        TransformerFactory factory = TransformerFactory.newInstance();
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_STYLESHEET, "");
        var transformer = factory.newTransformer();
        transformer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION, "yes");
        // Jena already supplied indentation. A second pretty-print could change literals.
        transformer.setOutputProperty(OutputKeys.INDENT, "no");
        StringWriter result = new StringWriter();
        transformer.transform(new DOMSource(document), new StreamResult(result));
        return result.toString();
    }

    private void rewriteXmlNode(Element node, boolean typed) {
        Document document = node.getOwnerDocument();
        if (typed) {
            List<Element> types = new ArrayList<>();
            for (Node child = node.getFirstChild(); child != null; child = child.getNextSibling()) {
                if (child instanceof Element property && RDF_NS.equals(property.getNamespaceURI())
                        && "type".equals(property.getLocalName()) && property.hasAttributeNS(RDF_NS, "resource")) types.add(property);
            }
            types.sort(Comparator.comparing(property -> property.getAttributeNS(RDF_NS, "resource")));
            for (Element type : types) {
                String iri = type.getAttributeNS(RDF_NS, "resource");
                if (iri.startsWith(RDF_NS) && RESERVED_NODE_NAMES.contains(iri.substring(RDF_NS.length()))) continue;
                int split = SplitIRI.splitXML(iri);
                if (split == 0 || split == iri.length()) continue;
                String namespace = iri.substring(0, split);
                if (XMLConstants.XMLNS_ATTRIBUTE_NS_URI.equals(namespace)) continue;
                // A valid type IRI does not always split into a valid namespace + XML name.
                try {
                    if (!URI.create(namespace).isAbsolute()) continue;
                } catch (IllegalArgumentException ex) { continue; }
                String prefix = xmlPrefix(document.getDocumentElement(), namespace);
                node = (Element) document.renameNode(node, namespace, prefix + ":" + iri.substring(split));
                Node whitespace = type.getPreviousSibling();
                if (whitespace != null && whitespace.getNodeType() == Node.TEXT_NODE && whitespace.getNodeValue().isBlank()) node.removeChild(whitespace);
                node.removeChild(type);
                break;
            }
        } else if (!RDF_NS.equals(node.getNamespaceURI()) || !"Description".equals(node.getLocalName())) {
            String iri = node.getNamespaceURI() + node.getLocalName();
            String prefix = xmlPrefix(document.getDocumentElement(), RDF_NS);
            node = (Element) document.renameNode(node, RDF_NS, prefix + ":Description");
            Element type = document.createElementNS(RDF_NS, prefix + ":type");
            type.setAttributeNS(RDF_NS, prefix + ":resource", iri);
            Node first = node.getFirstChild();
            String padding = first != null && first.getNodeType() == Node.TEXT_NODE && first.getNodeValue().isBlank() ? first.getNodeValue() : "";
            node.insertBefore(type, first);
            node.insertBefore(document.createTextNode(padding), type);
        }
        rewriteXmlProperties(node, typed);
    }

    private String xmlPrefix(Element root, String namespace) {
        String prefix = root.lookupPrefix(namespace);
        if (prefix == null) {
            int number = 1;
            do { prefix = "type" + number++; } while (root.lookupNamespaceURI(prefix) != null);
            root.setAttributeNS(XMLConstants.XMLNS_ATTRIBUTE_NS_URI, "xmlns:" + prefix, namespace);
        }
        return prefix;
    }

    /** Follow RDF node/property levels; XMLLiteral markup is never a graph node. */
    private void rewriteXmlProperties(Element node, boolean typed) {
        for (Node child = node.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (!(child instanceof Element property)) continue;
            String parseType = property.getAttributeNS(RDF_NS, "parseType");
            if ("Literal".equals(parseType) || property.hasAttributeNS(RDF_NS, "datatype")) continue;
            if ("Resource".equals(parseType)) rewriteXmlProperties(property, typed);
            else {
                for (Node value = property.getFirstChild(), next; value != null; value = next) {
                    next = value.getNextSibling();
                    if (value instanceof Element resource) rewriteXmlNode(resource, typed);
                }
            }
        }
    }

    private String pretty(JsonStructure value) {
        StringWriter out = new StringWriter();
        try (var writer = Json.createWriterFactory(Map.of(JsonGenerator.PRETTY_PRINTING, true)).createWriter(out)) {
            writer.write(value);
        }
        return out + "\n";
    }

    private boolean emptyFrame(JsonStructure output) throws JsonLdError {
        // A custom frame context may alias @graph, so inspect the processor's
        // expanded form instead of assuming a particular output property name.
        JsonArray expanded = output instanceof JsonArray array ? array
                : JsonLd.expand(JsonDocument.of(output)).options(options()).get();
        return expanded.isEmpty() || expanded.stream().allMatch(value ->
                value instanceof JsonObject object && object.size() == 1
                        && object.get("@graph") instanceof JsonArray graph && graph.isEmpty());
    }

    private ConversionResult success(@NonNull String id, @NonNull String name, @NonNull String type, String content, boolean empty) {
        return new ConversionResult(id, name, type, content, content.getBytes(StandardCharsets.UTF_8).length, null, empty);
    }

    private @NonNull String fileName(String method, @Nullable String representation) {
        String suffix = representation != null && ("flattened".equals(method) || "framed".equals(method))
                ? "-" + representation : "";
        return method + suffix + ".jsonld";
    }

    private ConversionResult failed(@NonNull String id, @NonNull String name, @NonNull String type, String error) {
        return new ConversionResult(id, name, type, null, 0, error, false);
    }

    private @NonNull ConversionResponse response(List<ConversionResult> results, List<@NonNull ConversionIssue> issues,
                                        @Nullable String context, @Nullable String frame, List<String> resources) {
        return new ConversionResponse(Objects.requireNonNull(List.copyOf(results)),
                Objects.requireNonNull(List.copyOf(issues)), context, frame, Objects.requireNonNull(resources), zip(results));
    }

    /** Returns a ZIP only when at least two successful files are available. */
    private @Nullable String zip(List<ConversionResult> results) {
        List<ConversionResult> successful = results.stream()
                .filter(result -> result.error() == null && result.content() != null).toList();
        if (successful.size() < 2) return null;
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes, StandardCharsets.UTF_8)) {
            for (ConversionResult result : successful) {
                zip.putNextEntry(new ZipEntry(result.fileName()));
                String content = Objects.requireNonNull(result.content(), "A successful conversion must supply content");
                zip.write(content.getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
            }
        } catch (IOException ex) {
            throw new UncheckedIOException("Die Ergebnisdateien konnten nicht als ZIP gepackt werden.", ex);
        }
        return Base64.getEncoder().encodeToString(bytes.toByteArray());
    }

    private @NonNull ConversionResponse failure(@NonNull String field, @NonNull String message) {
        return response(List.of(), List.of(new ConversionIssue(field, message)), null, null, List.of());
    }

    private static boolean nonblank(@Nullable String value) { return value != null && !value.isBlank(); }

    private static @NonNull String message(Exception ex) {
        String message = ex.getMessage();
        if (message == null || message.isBlank()) message = ex.getClass().getSimpleName();
        return Objects.requireNonNull(message.length() > 1200 ? message.substring(0, 1200) + "…" : message);
    }

    private static class ConversionInputException extends Exception {
        @Serial
        private static final long serialVersionUID = 1L;
        private final @NonNull String field;
        ConversionInputException(@NonNull String field, @NonNull String message) { super(message); this.field = field; }
    }
}
