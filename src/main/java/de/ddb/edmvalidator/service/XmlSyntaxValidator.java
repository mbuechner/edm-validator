package de.ddb.edmvalidator.service;

import de.ddb.edmvalidator.api.ValidationResultItem;
import org.springframework.stereotype.Component;
import org.xml.sax.SAXParseException;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.ParserConfigurationException;

@Component
public class XmlSyntaxValidator {

    private final ValidationItemFactory itemFactory;

    public XmlSyntaxValidator(ValidationItemFactory itemFactory) {
        this.itemFactory = itemFactory;
    }

    public ValidationResultItem validateWellFormed(byte[] xmlBytes) {
        try {
            DocumentBuilder builder = createSecureBuilder();
            builder.parse(new java.io.ByteArrayInputStream(xmlBytes));
            return itemFactory.success(ValidationSections.XML, "JAXP DOM", "XML ist wohlgeformt", null, null);
        } catch (SAXParseException ex) {
            return itemFactory.failure(ValidationSections.XML, "JAXP DOM", ex.getMessage(), ex.getLineNumber(), ex.getColumnNumber(), xmlBytes);
        } catch (Exception ex) {
            return itemFactory.failure(ValidationSections.XML, "JAXP DOM", ex.getMessage(), null, null, xmlBytes);
        }
    }

    private DocumentBuilder createSecureBuilder() throws ParserConfigurationException {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        factory.setXIncludeAware(false);
        factory.setExpandEntityReferences(false);
        factory.setNamespaceAware(true);
        return factory.newDocumentBuilder();
    }
}
