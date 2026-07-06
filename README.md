# EDM Validator (DDB)

Validator für EDM/RDF-Daten der Deutschen Digitalen Bibliothek auf Basis von Spring Boot.

## Voraussetzungen

- Java 21 LTS
- Maven 3.9+

## Starten

```bash
mvn spring-boot:run
```

Das erzeugte Build-Artefakt heisst versionslos:

```bash
target/edm-validator.jar
```

Danach im Browser oeffnen:

- http://localhost:8080/app/edm-validator

Der Basispfad ist per Environment-Variable konfigurierbar:

```bash
APP_BASE_PATH=/app/edm-validator
```

Wenn `APP_BASE_PATH` nicht gesetzt ist, verwendet die Anwendung standardmaessig `/app/edm-validator`.

## Docker

Container-Build lokal:

```bash
docker build -t edm-validator .
```

Der Container verwendet direkt das feste Maven-Artefakt `target/edm-validator.jar`.

Container starten:

```bash
docker run --rm -p 8080:8080 -e APP_BASE_PATH=/app/edm-validator edm-validator
```

Die Anwendung ist im Container als Non-Root-User konfiguriert.

Container aus GitHub Container Registry starten:

```bash
docker run --rm -p 8080:8080 -e APP_BASE_PATH=/app/edm-validator ghcr.io/<owner>/<repo>:latest
```

## CI

Eine GitHub-Action baut den Container bei Pushes und Pull Requests:

- Workflow: [.github/workflows/container-build.yml](.github/workflows/container-build.yml)
- Bei Pull Requests wird das Image gebaut, aber nicht gepusht.
- Bei Pushes auf den Default-Branch wird das Image zusaetzlich nach GitHub Container Registry veroeffentlicht.
- Registry-Ziel: `ghcr.io/<owner>/<repo>`
- Tags aus dem Workflow:
	- `latest` auf dem Default-Branch
	- Branch-Tag
	- Commit-SHA

## Validierungsumfang

Die Validierung ist in drei Abschnitte aufgeteilt:

- XML-Syntax
	- XML-Wohlgeformtheit (JAXP DOM)
	- RDF/XML-Grammatik (Apache Jena)
- RDF-Syntax
	- RDF-Parsing mit Apache Jena
	- RDF-Parsing mit RDF4J Rio
- SHACL
	- SHACL-Validierung mit Apache Jena
	- SHACL-Validierung mit RDF4J SHACL

Jeder Engine-Lauf liefert ein separates Ergebnisobjekt mit Originalmeldung, optionaler Erklaerung, Zeile/Spalte, Snippet und optionalen Metriken.

## DDB URL- und Base-Konfiguration

Zentrale Konstanten liegen in [src/main/java/de/ddb/edmvalidator/service/DdbConstants.java](src/main/java/de/ddb/edmvalidator/service/DdbConstants.java):

- DDB-Web-Item-Muster: https://www.deutsche-digitale-bibliothek.de/item/{ID}
- DDB-API-Base: https://api.deutsche-digitale-bibliothek.de/2/items/
- DDB-Resource-Base: https://www.deutsche-digitale-bibliothek.de/resource/

Die DDB-Resource-Base wird konsistent in Jena und RDF4J als Base-URI verwendet.

## SHACL-Schemaquellen (Europeana Metis)

Eingebundene Ressourcen:

- [src/main/resources/schema/edm_ext_shacl_shapes.ttl](src/main/resources/schema/edm_ext_shacl_shapes.ttl)
	- Quelle: https://raw.githubusercontent.com/europeana/metis-edm-ext-schema/main/src/main/resources/schema/edm_ext_shacl_shapes.ttl
- [src/main/resources/schema/edm_ext_class_definitions.ttl](src/main/resources/schema/edm_ext_class_definitions.ttl)
	- Quelle: https://raw.githubusercontent.com/europeana/metis-edm-ext-schema/refs/heads/main/src/main/resources/schema/edm_ext_class_definitions.ttl

Hinweis: Beide Dateien werden fuer die SHACL-Auswertung geladen, damit Klassenbeziehungen und Referenzregeln vollstaendig verfuegbar sind.

## API

- Endpoint: POST /api/validate
- Request: DDB-URI
- Response:
	- URL- und Downloadstatus
	- Abschnittsergebnisse (XML, RDF, SHACL)
	- Gesamtergebnis
	- RDF/XML-Inhalt (bei erfolgreichem Download)
	- Detailliste pro Engine

