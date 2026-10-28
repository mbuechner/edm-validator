# EDM Validator (DDB)

Validator für EDM/RDF-Daten der Deutschen Digitalen Bibliothek auf Basis von Spring Boot.

## Voraussetzungen

- Java 25
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
- RDF-Konverter: http://localhost:8080/app/edm-validator/converter.html

Validierung und RDF-Konverter sind eigenständige Seiten mit einem gemeinsamen
Menü. Beide nutzen die gesamte verfügbare Bildschirmbreite. Die Menülinks und
API-Aufrufe funktionieren auch unter einem anders konfigurierten Basispfad.

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

## RDF-Konverter

Die Seite **RDF-Konverter** ist über das Menü der Anwendung erreichbar. RDF/XML kann
direkt eingefügt, als `.rdf`, `.xml` oder `.owl` hochgeladen oder aus der bereits
angezeigten Dokumentansicht übernommen werden. Die Eingabe wird als RDF/XML
geparst; eine passende Dateiendung allein reicht nicht aus. Die Grenze beträgt
1 MiB pro Eingabe und entspricht dem bisherigen Spring-Boot-Uploadstandard.

**Im RDF-Konverter öffnen** überträgt das angezeigte Dokument samt bekannter
Dokument-IRI einmalig über den Sitzungsspeicher des Browsers auf die Konverterseite.
Der Übergabeeintrag wird dort sofort entfernt; XML-Inhalt steht nicht in der URL.

Der Konverter merkt sich die letzte RDF/XML-Eingabe samt Basis- und Dokument-IRI
im lokalen Browserspeicher. Sie steht nach Neuladen oder einem Wechsel zwischen
den Seiten wieder bereit. Das gilt für eingefügten Text, geladene Dateien und
übernommene Validierungsdaten. Eine neue Übergabe aus der Validierung hat Vorrang.
**Zurücksetzen** löscht die gespeicherte Konverter-Eingabe und stellt die
Standardwerte wieder her. Die gespeicherte Eingabe der Validierung bleibt separat.

Bei relativen Ressourcen-IRIs ist eine absolute Basis erforderlich: aus
`xml:base`, der bekannten ursprünglichen Dokument-IRI oder dem Feld **Basis-IRI**.
Lokale Dateinamen und temporäre Serverpfade werden nicht als Basis verwendet.

Die Oberfläche erzeugt genau **eine Ergebnisdatei**: entweder XML (RDF/XML) oder
JSON (JSON-LD). Standard ist JSON-LD in kompakter Form mit automatisch erzeugtem
Kontext. Eingabe und Ergebnis stehen auf großen Bildschirmen nebeneinander; auf
kleinen Bildschirmen untereinander.

Unter **Weitere Einstellungen** werden zwei unabhängige JSON-LD-Eigenschaften
gewählt: **Darstellung** (kompakt oder expandiert) und **Struktur** (Standardgraph,
getrennte Knoten oder eingebettete Ressource). Alle sechs Kombinationen sind
möglich. Expansion und Compaction sind JSON-LD-Verfahren und gelten nicht für
RDF/XML. XML wird neu serialisiert; das ist keine JSON-LD-Expansion oder -Compaction.

Für XML gibt es eigene, ebenfalls kombinierbare Einstellungen:

- **Darstellung:** typisiert oder explizit. Typisierte Ausgabe verwendet geeignete
  RDF-Typen als Elementnamen, beispielsweise `edm:TimeSpan`. Explizite Ausgabe
  schreibt Typangaben als `rdf:type` bei `rdf:Description`-Elementen.
- **Struktur:** flach oder verschachtelt. Flache Ausgabe hält die
  Ressourcenbeschreibungen getrennt und verwendet Referenzen für Verknüpfungen.
  Bei verschachtelter Ausgabe entscheidet Jena anhand des Graphen, welche
  Ressourcen eingebettet werden können; ihre IRIs bleiben erhalten.

Darstellung und Struktur sind unabhängig wählbar. Alle vier XML-Kombinationen
sind möglich; sie erhalten den vollständigen RDF-Graphen und erzeugen
`converted.rdf`. Standard ist die mit **(DDB)** markierte
typisierte, flache Ausgabe. XML und JSON werden immer lesbar eingerückt ausgegeben;
Leerzeichen in Literalwerten bleiben unverändert. JSON-LD-Frames und deren
Einbettungsregeln beeinflussen diese XML-Serialisierung nicht.

Für DDB-Dokumente, bei denen typisierte Elemente wie `edm:TimeSpan` und getrennte
Ressourcenbeschreibungen gewünscht sind, empfiehlt sich **Typisiert (DDB)** und
**Flach (DDB)**. Die Auswahl gilt allgemein für geeignete
RDF-Typen und enthält keine Sonderregeln für DDB-Klassen. Bei mehreren Typen wird
ein geeigneter Typ als Elementname gewählt; weitere Typen bleiben
ausdrücklich als `rdf:type` erhalten. Fehlt ein geeigneter XML-Elementname, bleibt die Ressource
ein `rdf:Description` mit ihren Typangaben.

Die XML-Ausgabe wird aus dem RDF-Graphen neu erzeugt. Ursprüngliche Element- und
Attributreihenfolge, Präfixnamen und Kommentare werden nicht exakt rekonstruiert.
Ressourcen-IRIs werden weiterhin absolut ausgegeben, damit die Bedeutung nicht
vom Download-Verzeichnis abhängt. Literalwerte einschließlich ihrer Leerzeichen
bleiben erhalten.

Bei einem RDF/XML-Schreibfehler zeigt die zentrale Meldung zusätzlich zur Ursache
passende Graph-IRIs oder vom Writer abgeleitete XML-Namespaces, betroffene
Prädikate, vorhandene Präfixdeklarationen und Beispielressourcen, soweit ermittelbar.
Die Diagnose verändert keine Daten und wird nur im Fehlerfall ausgeführt.
Weitere unabhängig angeforderte Ausgaben werden weiterhin erzeugt.

| Darstellung | Struktur | Datei |
| --- | --- | --- |
| RDF/XML typisiert / explizit | Flach / verschachtelt | `converted.rdf` |
| JSON-LD kompakt | Standardgraph | `compacted.jsonld` |
| JSON-LD expandiert | Standardgraph | `expanded.jsonld` |
| JSON-LD kompakt / expandiert | Getrennte Knoten | `flattened-compacted.jsonld` / `flattened-expanded.jsonld` |
| JSON-LD kompakt / expandiert | Eingebettete Ressource | `framed-compacted.jsonld` / `framed-expanded.jsonld` |

Apache Jena liest das RDF-Modell und serialisiert RDF/XML sowie die gemeinsame
JSON-LD-Ausgangsdarstellung mit `JSONLD11_PLAIN`. Der von Jena bereits transitiv
mitgebrachte Titanium-Prozessor übernimmt Expansion, Compaction,
Flattening und Framing über seine Bibliotheks-APIs. Die tatsächlichen APIs wurden
an den lokal verwendeten JARs geprüft; siehe auch die
[Jena-Ein-/Ausgabedokumentation](https://jena.apache.org/documentation/io/) und
[Titanium JSON-LD](https://github.com/filip26/titanium-json-ld).
Es werden keine zusätzlichen Laufzeitbibliotheken eingebunden. Titanium und JSON-P
stammen aus der vorhandenen Jena-Abhängigkeit; Upload-Optionen werden mit dem
bereits von Spring Boot konfigurierten Jackson-Mapper eingelesen.

Kontext, Basis-IRI und Frame-Konfiguration bleiben zunächst eingeklappt. Bei einem
Fehler wird der betroffene Bereich automatisch geöffnet und das Feld fokussiert.
Allgemeine Status- und Fehlermeldungen stehen gesammelt unter der Navbar als
schließbare Bootstrap-Alerts. Feldfehler bleiben zusätzlich am jeweiligen Editor
oder Eingabefeld sichtbar. Statische Hilfetexte werden nicht als Alerts dargestellt.
Der automatische Kontext übernimmt die Namespace-IRIs des Modells unverändert.
Alternativ akzeptiert der Kontexteditor ein JSON-Objekt mit oberstem `@context`.
Die expandierte Ausgabe enthält keinen Kontext. Für ein Frame kann ein Kontext
trotzdem zur Interpretation der Regeln nötig sein. Externe
Kontexte und XML-DTDs/Entitäten werden nicht nachgeladen.

Das Frame lässt sich über Wurzel-IRI und allgemeine Einbettungsregel konfigurieren
oder als eigenes JSON bearbeiten. Regeln für einzelne
Beziehungen werden ausschließlich im eigenen Frame angegeben. Ein eigener
Frame-Kontext hat Vorrang. Die Vorschau zeigt das wirksame Frame. Framing erzeugt
eine ausgewählte Ansicht und darf deshalb einen Teil des Eingabegraphen auslassen.
Zyklische Beziehungen bleiben bei Bedarf Referenzen; Ressourcen-IRIs bleiben erhalten.

Ergebnisse werden schreibgeschützt mit Syntaxhervorhebung angezeigt. Vorschau,
Zwischenablage und Browser-Download verwenden denselben Ergebnistext.
Bei blockiertem Zwischenablagezugriff wird der Quelltext zum Kopieren mit Strg+C
markiert; ein veralteter Kopieraufruf wird nicht verwendet.
Die Dateien enthalten UTF-8 mit `application/rdf+xml` bzw. `application/ld+json`.
Änderungen an Eingabe oder Einstellungen entfernen alte Ergebnisse.

Im normalen Ablauf wird nur das ausgewählte Ergebnis berechnet. Modellvorschauen
werden erst bei geöffneten JSON-Einstellungen nachgeladen und bis zur nächsten
Änderung an Quelle oder Basis wiederverwendet. Änderungen an Kontext- oder
Frame-Optionen lösen kein erneutes Einlesen für die Vorschau aus. Die
Syntaxhervorhebung beim Tippen wird gebündelt; sehr große Dokumente werden für
flüssiges Bearbeiten als Klartext angezeigt.
Vorschau-Anfragen enthalten nur XML, Basis-IRI und Dokument-IRI; XML-Ausgaben
übertragen keine ausgeblendeten JSON-LD-Optionen. Kontext- und Frame-Entwürfe
werden nur für die jeweils gewählten Verfahren übertragen.
Beim Bearbeiten ist der Text dunkel und direkt in der Textarea lesbar. Ohne Fokus
zeigt der vorbereitete Editor die Syntaxhervorhebung. Auch bei ausgefallenem
JavaScript oder nicht verfügbarer Syntaxbibliothek bleibt die Eingabe lesbar.
Alle XML-/JSON-Eingaben und Quelltextansichten beider Seiten verwenden dieselbe
Monospace-Schrift aus Bootstrap mit `0.75rem` (standardmäßig 12 px), Zeilenhöhe
`1.4` und Tabulatorbreite 4. Die gemeinsame Definition liegt in `source.css`;
zusätzliche Schriftdateien werden nicht geladen.
Die 3D-Bibliothek der Validierungsansicht wird erst geladen, wenn ein Graph
angezeigt werden soll; für die Konvertierung wird sie nicht benötigt.

Zusätzliche API-Endpunkte (jeweils relativ zum konfigurierten Basispfad):

- `POST /api/convert`: JSON mit `rdfXml` und Konvertierungseinstellungen.
- `POST /api/convert/inspect`: dieselbe Eingabe für Präfixkontext, Ressourcen und
  Frame-Vorschau, ohne Ergebnisdateien zu erzeugen.
- `POST /api/convert/upload`: Multipart mit `file` und optionalem `options`
  (JSON mit denselben Einstellungen). Die XML-Kodierungsdeklaration der Datei
  wird beim Einlesen berücksichtigt.

Die Antwort enthält `results` mit `id`, `fileName`, `mediaType`, `content`,
`sizeBytes`, `error` und `empty`, feldbezogene `errors`, `autoContext`,
`effectiveFrame` und `resources`. Bei mehreren erfolgreichen Ergebnissen enthält
`zipBase64` zusätzlich das ZIP-Archiv. `content` enthält das eigentliche Dokument;
der API-Antwortumschlag ist keine herunterzuladende RDF-Datei.

Die API unterstützt weiterhin mehrere unabhängige Ausgaben pro Anfrage und
stellt dann mit der Java-Standardbibliothek ein ZIP bereit. Ein fehlerhafter
Kontext oder ein fehlerhaftes Frame verhindert dort nur die abhängigen Ausgaben.
Die API-Eigenschaft `representation` (`compacted` oder `expanded`)
steuert die Darstellung für Flattening und Framing. Eine zweite Einstellung
für die Kontextdarstellung beim Flattening wird nicht benötigt. Beim expandierten
Framing wird die ausgewählte Ansicht zunächst eingebettet und anschließend mit
dem JSON-LD-Prozessor expandiert; die Einbettung bleibt dabei erhalten.
Die vereinfachte Oberfläche fordert stets nur ein Format und eine Kombination an.
Für XML steuern `xmlRepresentation` (`typed`/`explicit`) und `xmlStructure`
(`flat`/`nested`) die Ausgabe. Fehlende Werte verwenden `typed` und `flat`.
Die Ausgabe wird immer eingerückt formatiert. Diese XML-Optionen
wirken nur auf die RDF/XML-Ausgabe.

Fachliche Tests ausführen:

```bash
mvn test
```

Optionale Frontend-Regressionstests (Node.js; Testabhängigkeiten bleiben unter
dem ignorierten `target/`):

```bash
npm install --no-save --package-lock=false --prefix target/ui-check jsdom@26.1.0
node --test src/test/js/*.test.cjs
```

Diese DOM-Tests prüfen unter anderem die exklusive Formatauswahl, identische
Inhalte in Vorschau, Zwischenablage und Download, die Upload-Kodierung,
Frame-Entwürfe, bedarfsgerechte Vorschau-Anfragen und den Schutz vor veralteten
Antworten. Eine visuelle Browserprüfung ersetzen sie nicht.

