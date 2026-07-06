package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.ValidationResultItem;
import org.springframework.stereotype.Component;
import org.xml.sax.SAXException;
import org.xml.sax.SAXParseException;

import javax.xml.XMLConstants;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import javax.xml.validation.Validator;
import java.io.ByteArrayInputStream;
import java.net.URI;

@Component
public class EdmXsdValidator {

    private static final String EDM_XSD_URL = "https://www.europeana.eu/schemas/edm/EDM.xsd";

    private final ValidationItemFactory itemFactory;

    private volatile Schema cachedSchema;

    public EdmXsdValidator(ValidationItemFactory itemFactory) {
        this.itemFactory = itemFactory;
    }

    public ValidationResultItem validateAgainstEdmXsd(byte[] rdfXmlBytes) {
        try {
            Validator validator = getSchema().newValidator();
            safeSetProperty(validator, XMLConstants.ACCESS_EXTERNAL_DTD, "");
            safeSetProperty(validator, XMLConstants.ACCESS_EXTERNAL_SCHEMA, "http,https");
            validator.validate(new javax.xml.transform.stream.StreamSource(new ByteArrayInputStream(rdfXmlBytes)));
            return itemFactory.success(ValidationSections.XML, "EDM XSD", "EDM-XSD-Validierung erfolgreich", null, null);
        } catch (SAXParseException ex) {
            return itemFactory.failure(ValidationSections.XML, "EDM XSD", ex.getMessage(), ex.getLineNumber(), ex.getColumnNumber(), rdfXmlBytes);
        } catch (SAXException ex) {
            return itemFactory.failure(ValidationSections.XML, "EDM XSD", ex.getMessage(), null, null, rdfXmlBytes);
        } catch (Exception ex) {
            return itemFactory.failure(ValidationSections.XML, "EDM XSD", ex.getMessage(), null, null, rdfXmlBytes);
        }
    }

    private Schema getSchema() {
        Schema current = cachedSchema;
        if (current != null) {
            return current;
        }

        synchronized (this) {
            if (cachedSchema == null) {
                try {
                    SchemaFactory schemaFactory = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
                    schemaFactory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
                    safeSetProperty(schemaFactory, XMLConstants.ACCESS_EXTERNAL_DTD, "");
                    safeSetProperty(schemaFactory, XMLConstants.ACCESS_EXTERNAL_SCHEMA, "http,https");
                    cachedSchema = schemaFactory.newSchema(URI.create(EDM_XSD_URL).toURL());
                } catch (Exception ex) {
                    throw new IllegalStateException("EDM-XSD konnte nicht geladen werden: " + ex.getMessage(), ex);
                }
            }
            return cachedSchema;
        }
    }

    private void safeSetProperty(Object target, String property, String value) {
        try {
            if (target instanceof SchemaFactory schemaFactory) {
                schemaFactory.setProperty(property, value);
            } else if (target instanceof Validator validator) {
                validator.setProperty(property, value);
            }
        } catch (Exception ignored) {
            // Runtime may not support all JAXP security properties.
        }
    }
}
