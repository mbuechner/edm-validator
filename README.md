# EDM-Werkzeuge (DDBpro)

RDF/XML erkunden, validieren, abfragen und konvertieren: Werkzeuge für EDM-Daten
der Deutschen Digitalen Bibliothek auf Basis von Spring Boot.

## Voraussetzungen

- Java 25
- Maven 3.9+

Lombok erzeugt die reinen Injection-Konstruktoren und Logger. Seine Version wird
von Spring Boot verwaltet; der Annotation Processor ist für Java 25 ausdrücklich
im Maven-Compiler konfiguriert. Lombok wird nicht in das ausführbare JAR gepackt.
Siehe [Lombok mit Maven](https://projectlombok.org/setup/maven).

Die Java-API verwendet [JSpecify](https://jspecify.dev/docs/user-guide/) für ihre
Nullverträge: `@Nullable` kennzeichnet optionale Eingaben, Fehlerdetails und
Parsermodelle. DTOs mit `@NullMarked` enthalten sonst erforderliche Werte.
An ausgewählten Bibliotheksgrenzen sichern explizite Prüfungen die Verträge auch zur Laufzeit ab;
die Nullanalyse der IDE bleibt aktiviert.

## Starten

```bash
mvn spring-boot:run
```

Das erzeugte Build-Artefakt heisst versionslos:

```bash
target/edm-validator.jar
```

Danach im Browser oeffnen:

- Explorer (Startseite): http://localhost:8080/app/edm-validator/
- Validierung: http://localhost:8080/app/edm-validator/validation.html
- Query: http://localhost:8080/app/edm-validator/query.html
- Konverter: http://localhost:8080/app/edm-validator/converter.html

Alle vier Werkzeuge sind eigenständige Seiten mit einem gemeinsamen
Menü. Der Explorer ist als `index.html` die statische Startseite.
Sie nutzen die gesamte verfügbare Bildschirmbreite. Die Menülinks und
API-Aufrufe funktionieren auch unter einem anders konfigurierten Basispfad.
Die Seitentitel nennen Werkzeug, Anwendung und DDBpro. Die Navbar verwendet das
originale DDBpro-Logo; auf kleinen Bildschirmen erscheint dessen DDB-Signet.
Beide SVG-Dateien werden unverändert lokal unter `static/images/` ausgeliefert.

Beim Start auf die Meldung `Started EdmValidatorApplication` warten und das
Terminal mit `mvn spring-boot:run` geöffnet lassen. `ERR_CONNECTION_REFUSED` bei
`/api/source` bedeutet, dass der Browser die lokale Anwendung nicht erreicht;
die Anfrage ist dann noch nicht bei der DDB-API angekommen.

### Gemeinsame RDF-Eingabe

Jede Seite beginnt mit Überschrift und Kurzbeschreibung. Darunter liegt dieselbe
RDF/XML-Eingabe als Bootstrap-Akkordeon: ohne Daten geöffnet, mit vorhandenen oder
neu geladenen Daten geschlossen. Zum Bearbeiten lässt es sich jederzeit öffnen;
während des Tippens bleibt es offen. RDF/XML kann direkt eingefügt,
als Datei geöffnet oder mit **Laden** aus einer DDB-URI abgerufen werden.
Der Abruf befüllt die Textarea; danach verwenden alle Werkzeuge genau diesen
bearbeitbaren Inhalt. Eine Validierung ist weder für den Explorer noch für
Abfragen oder Konvertierungen erforderlich.

Die Eingabe und ihre bekannte Dokument-IRI werden unter `ddb-rdf-source-v1` im
lokalen Browserspeicher gespeichert und beim Seitenwechsel oder Neuladen
wiederhergestellt. Geöffnete Tabs derselben Anwendung übernehmen Änderungen.
Beim Tippen werden Schreibvorgänge für 250 ms gebündelt; Navigation, Ausblenden
oder Verlassen der Seite sichern den aktuellen Stand sofort. Laden und Leeren
werden unmittelbar gespeichert. Reine URI-/Profiländerungen in einem anderen
Tab überschreiben keinen noch ungespeicherten Textentwurf.
**Eingabe leeren** leert die gemeinsame Quelle für alle Werkzeuge. Bei gesperrtem
oder vollem Browserspeicher erscheint ein Hinweis; das aktuelle Werkzeug bleibt
nutzbar. Alte getrennte Eingaben werden beim ersten Start übernommen.

Eine DDB-URI wird erst durch den Ladebutton oder Enter abgerufen. Das Tippen einer
anderen URI verändert das vorhandene RDF/XML nicht. Ein fehlgeschlagener Abruf
oder Upload erhält den bisherigen Text. Änderungen während einer Anfrage
verhindern, dass verspätete Antworten den neuen Stand überschreiben.

Dateien und DDB-Abrufe sind auf 1 MiB begrenzt. XML-Kodierungsdeklarationen sowie
UTF-8-/UTF-16-Markierungen werden beim Dateiimport berücksichtigt. Die bekannte
Dokument-IRI dient allen Werkzeugen als Basis für relative RDF-IRIs.

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

Die Oberfläche zeigt die vier Prüfschritte kompakt an. **Prüfdetails** bleiben bei
erfolgreichen Prüfungen eingeklappt und öffnen sich bei einem Fehler automatisch.

Das externe EDM-XSD einschließlich seiner Imports und Includes wird bereits beim
Anwendungsstart geladen. Das kompilierte Schema bleibt bis zum Ende des
Anwendungsprozesses im Speicher; jede Dokumentprüfung erhält einen eigenen
Validator. Nach erfolgreichem Laden benötigt die XSD-Prüfung keinen Netzzugriff.
Die SHACL-Schemas liegen bereits lokal im Klassenpfad.
RDF4J hält außerdem ihr geparstes, unveränderliches Modell im Speicher, statt
dieselben Turtle-Dateien pro Anfrage erneut einzulesen. Jede Prüfung erhält
weiterhin ein eigenes Repository. Jena-Modelle werden nach der Verarbeitung
auch auf Fehlerpfaden freigegeben.

Für das externe Schema gelten 5 Sekunden Verbindungszeitlimit, 10 Sekunden pro
Abruf und ein gemeinsames Ladebudget von 30 Sekunden für Hauptschema und
Abhängigkeiten. Scheitert das Laden, startet die Anwendung trotzdem und protokolliert
die Ursache. Die XSD-Prüfung meldet dann die fehlende Schema-Verfügbarkeit; die
übrigen Prüfungen laufen weiter. Frühestens nach 30 Sekunden stößt eine neue
Validierungsanfrage einen weiteren Ladeversuch an. Ein erfolgreich geladenes
Schema wird während der Laufzeit nicht erneut heruntergeladen.

Das Serverlog enthält pro Validierung eine Kennung sowie Gesamtdauer und
Laufzeiten der einzelnen Prüfschritte. Schritte ab 10 Sekunden werden zusätzlich
als Warnung protokolliert. Für Beginn und Ende jedes Schritts kann
`logging.level.de.ddb.edmvalidator.service.DdbEdmValidationService=DEBUG` gesetzt
werden. RDF/XML-Inhalte werden dabei nicht ins Log geschrieben.

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

## Interaktive Graphansicht

Der eigenständige **Explorer** öffnet eine gespeicherte Eingabe direkt als
Graph. Nach einer Änderung erstellt **Graph anzeigen** die Ansicht neu, ohne die
Validierungsengines zu starten. Der Explorer verwendet Bootstrap-Cards, Buttons, Formulare und Badges mit den
DDB-Farben und der lokal bereitgestellten Inter-Schrift. Die Schriftlizenz liegt
unter `src/main/resources/static/fonts/OFL-Inter.txt`; Code-Editoren behalten ihre
bisherige Monospace-Schrift. Die helle Graphfläche zeigt Ressourcenbeziehungen
mit kräftigen Linien und Richtungspfeilen. Die Palette folgt den Primär- und
Sekundärfarben des DDB-Styleguides. Für die Datenkategorien werden kräftige
Rot- und Blautöne sowie dunkle Grautöne verwendet; die Bedienelemente bleiben
im DDB-Rot. Die ebenfalls im Guide genannten Blautöne ergänzen hier die
Graphpalette, während Farben und Formen gemeinsam den Knotentyp zeigen.
Die Knotentypen unterscheiden sich zusätzlich durch ihre Form:

| Typ | Form | Farbe |
| --- | --- | --- |
| Kulturobjekt | Würfel | DDB-Dunkelrot `#A5003B` |
| Ressource | Kugel | Dunkelblau `#2D4694` |
| RDF-Klasse | Oktaeder / Raute | Dunkelgrau `#383838` |
| Ort | Ring | DDB-Hellrot `#EC0A3C` |
| Akteur | Dodekaeder | Mittelblau `#0096CC` |
| Literalwert | Kleine Kugel | Grau `#727579` |

Innerhalb eines Knotentyps wächst die Größe mit der Anzahl seiner Verbindungen
im geladenen Graphen. Die logarithmische, begrenzte Skalierung macht stark
vernetzte Knoten erkennbar und erhält die Lesbarkeit weniger vernetzter Knoten.
Unbeleuchtete Materialien erhalten die Farben unabhängig von Licht und Drehung.

- **Vollbild** erweitert den gesamten Explorer einschließlich Suche und
  Knoten-Details. Ohne verfügbare Fullscreen-API wird eine bildschirmfüllende
  Ansicht verwendet. Escape oder **Vollbild beenden** stellt die Seite wieder her.
- Die Ansicht startet für jedes Dokument mit dem gesamten geladenen Graphen,
  ohne vorausgewählten Knoten. **Gesamtansicht** hebt einen späteren Fokus auf
  und passt die Kamera erneut an alle Knoten an.
- Die **Suche** findet Knoten nach Bezeichnung, IRI oder Klasse.
  Ein Klick hebt den Knoten hervor und zeigt die Beziehungen im Detailbereich.
  Die Zoomstufe und Kameraposition bleiben bei jeder Knotenauswahl unverändert,
  auch bei Suchtreffern und beim Folgen einer Verbindung.
- Beim Überfahren oder Auswählen eines Knotens wird seine Nachbarschaft
  hervorgehoben. Tooltips nennen Bezeichnung, Klassen und IRI.
- **Beschriftungen** ist der einzige Darstellungsschalter und startet
  ausgeschaltet. Eingeschaltet werden wenige, kollisionsgeprüfte Labels gezeigt;
  sie fangen keine Klicks ab. Details bleiben im Seitenbereich lesbar.
- Die Darstellung verwendet feste, ruhige Vorgaben ohne Filter- oder
  Animationskonfiguration und ohne automatische Kamerafahrten.

Selten benötigte Funktionen bleiben verfügbar, ohne den normalen Ablauf zu
überladen: Das Europeana-Profil liegt bei der gemeinsamen Eingabe unter
**Option für den DDB-Abruf**. Im Konverter bleiben die erweiterten Einstellungen
standardmäßig eingeklappt.

Die Vorschau enthält weiterhin höchstens 1.200 RDF-Aussagen. Knoten-Details
beziehen sich auf diesen Ausschnitt. Typzuweisungen und Ressourcenbeziehungen
werden vor Literalwerten berücksichtigt, damit die Struktur bei großen
Dokumenten erhalten bleibt. Gleichlautende Literale bleiben nach Sprache und Datentyp getrennte
Knoten; ihre Beschriftung zeigt den vollständigen Text. Die Auswahl hält nur
begrenzte Kandidatenlisten vor, statt den gesamten Graphen zu sortieren.
Die Oberfläche führt RDF-Texte nicht als
HTML aus. Darstellung und Interaktion liegen in `graph.js` und `graph.css`,
die Symbolformen in `graph-nodes.js`. Die Anfangssimulation wird vor der Anzeige
vorbereitet; `graph-fit.js` berechnet die Perspektive aus allen Knotenpositionen
einschließlich der gesamten Formradien und des sichtbaren Bildrands.
Die Bibliothek `3d-force-graph` ist auf Version `1.80.0` festgelegt und liegt mit
dem passenden Three.js-Kern `0.183.2` lokal unter `static/vendor/`, einschließlich
der Lizenzen. Beide Bibliotheken werden nur für eine geladene Graphansicht benötigt.

## Query

Die eigene Seite **Query** führt SPARQL und XPath unmittelbar auf der
gemeinsamen RDF/XML-Eingabe aus. XPath verwendet den XML-Parser des Browsers,
die im Dokument deklarierten Namensraumpräfixe und einen zwischengespeicherten
Dokumentbaum. Auf breiten Bildschirmen stehen Abfrage und Ergebnis nebeneinander,
auf kleinen Bildschirmen untereinander.
SPARQL steht als erster Tab beim Öffnen der Seite bereit.
**Beispiel laden** im XPath-Tab setzt `//dc:title/text()` ein. Diese einfache
Abfrage liefert beim Museumsbeispiel den Titel **Tanzendes Bauernpaar** und
funktioniert unabhängig davon, ob der Titel am Objekt oder an einem Proxy steht.

SPARQL verwendet **Oxigraph 0.5.13** direkt für RDF/XML und Standard-SPARQL 1.1.
Beim ersten Ausführen startet ein eigener Modul-Web-Worker und initialisiert
WebAssembly einmal. Der Store bleibt im Worker erhalten; nur geändertes XML oder
eine geänderte Dokument-Basis-IRI führen zu einem neuen RDF-Ladevorgang. Eine
andere Abfrage überträgt das XML nicht erneut. Die bekannte Dokument-IRI (sonst
die Seiten-URL) dient als Basis. Absolute `xml:base`-Angaben verarbeitet Oxigraph
selbst. Relative und verschachtelte Angaben werden für Oxigraph 0.5.13 vor dem
Laden im Worker zu absoluten Basis-IRIs aufgelöst, da dessen XML-Parser sie sonst
ablehnt. Ein SAX-Parser ändert dabei gezielt nur die relativen Basisattribute,
ohne XML-Literalinhalte umzuschreiben. Die gespeicherte Eingabe bleibt unverändert;
es entsteht kein RDF-Zwischenformat. Diese Aufbereitung entfällt bei einem
wiederverwendeten Store.

Die Oberfläche zeigt Initialisierung, RDF-Laden und Abfrageausführung an.
**RDF laden** und **Abfrage** werden im Worker getrennt mit `performance.now()`
gemessen; ein wiederverwendeter Store zeigt `0 ms` Ladezeit. Die Abfragezeit enthält
die native Ergebniserzeugung, die anschließende JSON-Aufbereitung wird zusätzlich
intern als `serializeMs` gemessen. Parser- und Abfragefehler erscheinen beim
Ergebnis. Anfrage- und Quellkennungen verhindern, dass verspätete Antworten neuere
Ergebnisse überschreiben. Ein Worker-Absturz oder ein Zeitlimit von 60 Sekunden
erlaubt einen neuen Versuch; Seitenwechsel beenden den Worker.

SELECT-Abfragen liefern ein JSON-Array mit einem flachen Objekt je Ergebniszeile:
Variablennamen werden zu Schlüsseln, RDF-Termwerte zu Strings, ungebundene Variablen
zu `""`. Auch Zahlen bleiben lexikalische Strings. Alle projizierten Variablen
bleiben erhalten. Die Ausgabe entsteht mit `JSON.stringify` und enthält keine
SPARQL-Bindings-Hülle. ASK liefert einen JSON-Boolean; CONSTRUCT und DESCRIBE
liefern JSON-LD. Die Abfrageschnittstelle führt keine SPARQL-Updates aus.

Der SPARQL-Editor startet leer. **Beispiel 1** lädt eine einfache Abfrage nach
Ortsbezeichnungen. **Beispiel 2** lädt die vollständige Abfrage
**RDF/XML → Portal-JSON** aus
[`portal-select.rq`](src/main/resources/static/queries/portal-select.rq).
Beide Beispiele bleiben im Editor bearbeitbar. Für einen anderen Datensatz lässt
sich die Objekt-IRI direkt im `VALUES ?objekt`-Block der Portal-Abfrage ersetzen.
Die Portal-Abfrage liefert 20 Felder, darunter getrennte Felder für
Digitalisat- und Metadatenrechte. Format und Rechte werden zum ausgewählten
Digitalisat gelesen; Ereignistyp, Person und Zeit bleiben demselben Ereignis
zugeordnet. Die Reihenfolge von `GROUP_CONCAT`-Texten ist nicht festgelegt.
Die Abfrage gliedert sich in Objektauswahl, Textfelder, URLs, Digitalisat und
Metadaten. Jedes Textfeld hat eine beschriftete Unterabfrage mit einfachem
`GROUP_CONCAT`: vorhandene Werte werden gesammelt, Duplikate entfernt und durch
`; ` getrennt. So entfallen die verschachtelten Ausdrücke zum Umgang mit leeren
Werten. Die einzelnen Felder erzeugen keine Kombination aller Personen,
Datierungen und Abmessungen. Metadatenrechte werden anhand der ausgewählten
Datensatz-ID zugeordnet; Rechte eines anderen Metadatensatzes werden nicht
übernommen. Fehlende Angaben ergänzt die JSON-Ausgabe weiterhin mit `""`.

ES-Modul und WASM stammen aus dem geprüften npm-Paket `oxigraph@0.5.13` und liegen
mit beiden Lizenzen lokal unter `static/vendor/oxigraph-0.5.13/`. Das offizielle
`web.js` ist bytegleich als `oxigraph.mjs` abgelegt. Maven übernimmt die Dateien
als statische Ressourcen; ein zusätzlicher JavaScript-Build ist nicht erforderlich.
Der Server liefert WASM als `application/wasm` und komprimiert es bei Bedarf.
RDFLib wurde entfernt; N3 und Comunica gehörten nicht zu dieser Anwendung.
Der nur für diesen Kompatibilitätsfall nachgeladene SAX-Parser liegt mit
Quellnachweisen und Lizenzen unter `static/vendor/saxes-6.0.0/`.

Die Tests verwenden das echte mitgelieferte WASM, einschließlich einer Ausführung
in einem separaten Worker-Thread. Die Portal-Fixture unter
`src/test/resources/query/portal-controlled.rdf.xml` ist ein kontrollierter
Testdatensatz mit zwei Objekten, mehreren Ereignissen und Digitalisaten. Sie prüft
alle 20 Felder, leere Werte und die fachliche Zuordnung. Zusätzlich wird der
bereitgestellte Museumsdatensatz **Tanzendes Bauernpaar** als
[`224IOLKFSF3WLN3FUEHIBGIVX3PRYU6I.rdf.xml`](src/test/resources/query/224IOLKFSF3WLN3FUEHIBGIVX3PRYU6I.rdf.xml)
geprüft. Die Testkopie korrigiert zwei Quellschreibfehler: zweimal
`edm:occuredAt` zu `edm:occurredAt` und den Aggregationsbezeichner
`#ddbAggegation` zu `#ddbAggregation`. Die Originaldatei unter `tmp/` bleibt
unverändert; die Anwendung korrigiert keine RDF-Prädikate oder Ressourcen-IRIs.
Die Regression prüft auch den unkorrigierten Fall, in dem Ereigniszeiten fehlen.
Mit der korrigierten Quelle gehören **Hieronymus Wierix / 1568–1619** zur
Herstellung und **Albrecht Dürer / 1514** zum Entwurf. Das Digitalisat behält
Public Domain Mark; die Metadaten behalten CC0. `beschreibung` bleibt leer,
weil die Quelle keine entsprechende Angabe enthält.

Lokale Messung am 29.10.2026 mit dem Museumsdatensatz im tatsächlichen Worker
(10.648 Byte, 115 Tripel): WASM-Initialisierung 38,0 ms, RDF-Laden 9,5 ms,
erste Abfrage 68,5 ms, Median der weiteren Abfragen 10,2 ms. 100 Abfragen laden
RDF und WASM jeweils einmal; nach einer Datenänderung beträgt die RDF-Ladezeit
1,7 ms. Die Zeiten stammen aus dem Node-Worker-Test mit Browser-API-Adapter,
ohne HTTP-Netzwerkzeit. Dies sind isolierte Funktionsmessungen und keine
Browser- oder Lasttestgarantie.
Die Messung lässt sich separat wiederholen:

```bash
node --test --test-name-pattern="supplied museum portal" src/test/js/sparql-worker-runtime.test.cjs
```

## Konverter

Die Seite **Konverter** ist über das Menü der Anwendung erreichbar und nutzt
die gemeinsame Eingabe. Die Eingabe wird als RDF/XML
geparst; eine passende Dateiendung allein reicht nicht aus. Die Grenze beträgt
1 MiB pro Eingabe und entspricht dem bisherigen Spring-Boot-Uploadstandard.

**Einstellungen zurücksetzen** stellt die Konvertierung auf ihre Standardwerte
zurück und erhält das gemeinsame RDF/XML. Der Inhalt wird ausschließlich über
**Eingabe leeren** entfernt. XML-Inhalt wird nicht in Menülinks oder URLs abgelegt.

Bei relativen Ressourcen-IRIs ist eine absolute Basis erforderlich: aus
`xml:base`, der bekannten ursprünglichen Dokument-IRI oder dem Feld **Basis-IRI**.
Lokale Dateinamen und temporäre Serverpfade werden nicht als Basis verwendet.

Die Oberfläche erzeugt genau **eine Ergebnisdatei**: entweder XML (RDF/XML) oder
JSON (JSON-LD). Standard ist JSON-LD in kompakter Form mit automatisch erzeugtem
Kontext. Unter der gemeinsamen Eingabe stehen Einstellungen und Ergebnis auf
großen Bildschirmen nebeneinander; auf kleinen Bildschirmen untereinander.

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

Basis-IRI und Frame-Konfiguration bleiben zunächst eingeklappt. Bei einem
Fehler wird der betroffene Bereich automatisch geöffnet und das Feld fokussiert.
Allgemeine Status- und Fehlermeldungen stehen gesammelt unter der gemeinsamen Eingabe als
schließbare Bootstrap-Alerts. Feldfehler bleiben zusätzlich am jeweiligen Editor
oder Eingabefeld sichtbar. Statische Hilfetexte werden nicht als Alerts dargestellt.
Die Oberfläche erzeugt den Kontext immer aus den Namespace-IRIs des Modells.
Eine Kontext-Konfiguration oder zusätzliche Kontextvorschau ist nicht erforderlich;
bei kompakten Ausgaben steht der Kontext im Ergebnisdokument.
Die expandierte Ausgabe enthält keinen Kontext. Für ein Frame kann ein Kontext
trotzdem zur Interpretation der Regeln nötig sein; dieser wird ebenfalls automatisch
eingesetzt. Ein eigener Root-Kontext im Frame wird dabei ersetzt, verschachtelte
Kontexte werden mit einem verständlichen Frame-Fehler abgelehnt. Externe
Kontexte und XML-DTDs/Entitäten werden nicht nachgeladen.

Das Frame lässt sich über Wurzel-IRI und allgemeine Einbettungsregel konfigurieren
oder als eigenes JSON bearbeiten. Regeln für einzelne
Beziehungen werden ausschließlich im eigenen Frame angegeben. Framing erzeugt
eine ausgewählte Ansicht und darf deshalb einen Teil des Eingabegraphen auslassen.
Zyklische Beziehungen bleiben bei Bedarf Referenzen; Ressourcen-IRIs bleiben erhalten.

Ergebnisse werden schreibgeschützt mit Syntaxhervorhebung angezeigt. Vorschau,
Zwischenablage und Browser-Download verwenden denselben Ergebnistext.
Bei blockiertem Zwischenablagezugriff wird der Quelltext zum Kopieren mit Strg+C
markiert; ein veralteter Kopieraufruf wird nicht verwendet.
Die Dateien enthalten UTF-8 mit `application/rdf+xml` bzw. `application/ld+json`.
Änderungen an Eingabe oder Einstellungen entfernen alte Ergebnisse.

Im normalen Ablauf wird nur das ausgewählte Ergebnis berechnet. Ressourcen für
die Frame-Auswahl werden erst bei geöffneten Framing-Einstellungen nachgeladen
und bis zur nächsten Änderung an Quelle oder Basis wiederverwendet.
Die Syntaxhervorhebung des optionalen Frame-Editors wird beim Tippen gebündelt;
sehr große Entwürfe werden für flüssiges Bearbeiten als Klartext angezeigt.
Vorschau-Anfragen enthalten nur XML, Basis-IRI und Dokument-IRI; XML-Ausgaben
übertragen keine ausgeblendeten JSON-LD-Optionen. Ein Frame-Entwurf wird nur beim
gewählten Framing-Verfahren übertragen.
Die gemeinsame RDF/XML-Textarea bleibt durchgehend ein normaler, lesbarer
Bootstrap-Editor und erhält eine XML-Syntaxhervorhebung auch während des Tippens.
Ein rein visueller Spiegel übernimmt Farben; Cursor, Auswahl, Rückgängig und
Zwischenablage verwenden weiterhin das native Textfeld. Bei fehlender
Hervorhebung, hohem Kontrastmodus oder mehr als 200.000 Zeichen bleibt der Text
als Klartext bearbeitbar. Die Hervorhebung wird gebündelt aktualisiert und
beeinflusst weder den Inhalt noch die gemeinsame Speicherung.
Der Frame-Editor zeigt ohne Fokus eine vorbereitete
Syntaxhervorhebung; beim Bearbeiten ist sein Text dunkel und direkt lesbar. Ist die
Syntaxbibliothek nicht verfügbar, bleibt er als Klartext nutzbar.
Alle XML-/JSON-Eingaben und Quelltextansichten der vier Seiten verwenden dieselbe
Monospace-Schrift aus Bootstrap mit `0.75rem` (standardmäßig 12 px), Zeilenhöhe
`1.4` und Tabulatorbreite 4. Die gemeinsame Definition liegt in `source.css`;
für die Codeansichten werden keine zusätzlichen Schriftdateien geladen.
Code-Ausgaben des Konverters, XML-Treffer in Query und technische Prüfmeldungen
erhalten Zeilennummern. Die Nummern sind dekorativ und werden weder mitkopiert
noch heruntergeladen oder von Screenreadern vorgelesen. Der Ausgabeinhalt bleibt
einschließlich Leerzeilen, Zeilenenden und Sonderzeichen unverändert. Bei sehr
langen Ausgaben werden nur die gerade sichtbaren Zeilennummern aufgebaut.

Prism `1.29.0` wird mit XML- und JSON-Grammatik lokal unter `static/vendor/`
ausgeliefert; die MIT-Lizenz liegt daneben in `PRISM-LICENSE.txt`.
Die Integration verwendet die öffentlichen
[Prism-APIs](https://prismjs.com/extending.html#api).
`code-view.js` und `code-view.css` übernehmen die nummerierten Ausgaben,
`rdf-source.js` und `source.css` den gemeinsamen Editor und die Tokenfarben.
Die 3D-Bibliothek der Explorerseite wird erst geladen, wenn ein Graph
angezeigt werden soll; für die Konvertierung wird sie nicht benötigt.

Zusätzliche API-Endpunkte (jeweils relativ zum konfigurierten Basispfad):

- `POST /api/source`: JSON mit `ddbUri` und optionalem `europeanaProfile` lädt
  RDF/XML von der DDB. Die Antwort enthält `ddbUri`, `apiUrl`, `rdfXml`, `error`.
  Falsche DDB-URLs werden vor einem HTTP-Abruf abgelehnt; der Abruf liest höchstens 1 MiB.
- `POST /api/graph`: JSON mit `rdfXml` und optionalem `documentIri` erstellt
  die Vorschau mit `graphNodes`, `graphLinks`, `error`, ohne Validierung oder Download.
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
Die Oberfläche verwendet `contextMode: "generated"`, damit auch eigene Frames
den Kontext aus den aktuellen Quelldaten verwenden. Die bisherigen API-Modi
`auto` und `custom` bleiben für vorhandene API-Clients unverändert verfügbar.
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

Diese DOM-Tests prüfen unter anderem die gemeinsamen Eingaben und Seitenwechsel,
unabhängige Graph-/Query-Aufrufe, die exklusive Formatauswahl, identische
Inhalte in Vorschau, Zwischenablage und Download, die Upload-Kodierung,
Frame-Entwürfe, bedarfsgerechte Vorschau-Anfragen und den Schutz vor veralteten
Antworten. Eine visuelle Browserprüfung ersetzen sie nicht.

## Laufzeit und Performance

Die Abhängigkeiten beschränken sich auf die verwendeten Jena-SHACL-/ARQ-Funktionen;
ungenutzte Datenbank-, Ontologie- und ShEx-Module werden nicht mit ausgeliefert.
Beispiel-RDF liegt unter `src/test/resources/examples/` und wird dort durch einen
lokalen API-Integrationstest geprüft. Es gehört nicht zum Laufzeitpaket.

Textressourcen und große JSON-/RDF-Antworten werden ab 2 KiB komprimiert, wenn der
Client dies unterstützt. Die Einstellungen stehen unter `server.compression.*`.
Der Docker-Einstieg startet Java mit `exec`, damit Beendigungssignale unmittelbar
ankommen.

Lokale Vergleichsmessungen vom 29.10.2026 (kurze isolierte Messreihen, kein Lasttest):

| Arbeitsschritt | Vorher | Nachher |
| --- | --- | --- |
| Ausführbares JAR, einschließlich lokaler Oxigraph-/WASM-Ressourcen | 56,8 MB | 54,8 MB |
| Laufzeitbibliotheken im JAR | 129 | 113 |
| Graphvorschau, 100.000 gemischte Tripel, Median | 24,8 ms | 15,8 ms |
| Allokationen derselben Graphvorschau | 24,9 MiB | 11,3 MiB |
| RDF4J-SHACL, unverändertes Schema, Median | 70,9 ms | 65,1 ms |
| 100 Texteingaben mit etwa 200 kB XML | 100 Speichervorgänge | 1 Speichervorgang |
| 20 XPath-Abfragen auf gleichem XML | 20 XML-Parses | 1 XML-Parse |
| Übertragung des unveränderten Three.js-Kerns mit gzip | 382.617 Bytes | 100.758 Bytes |

Die Servermessungen verwendeten dieselben vorbereiteten Graphen, Aufwärmläufe
und mehrere Wiederholungen. Frontend-Zählungen stammen aus DOM-Regressionstests;
sie sind keine Messung der sichtbaren Reaktionszeit eines Browsers.

