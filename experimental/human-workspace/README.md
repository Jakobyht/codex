# Human Workspace Lab

Ein erster Baustein für einen gemeinsamen Arbeitsraum von Mensch und KI. Der Mensch kann direkt auf ein Ergebnis zeigen, Feedback geben und Bild- oder Videoanhänge ergänzen. Die Referenz enthält die konkrete Version, damit eine spätere Änderung nicht versehentlich eine andere Stelle trifft.

Der Prototyp ergänzt Codex als eigenes Experiment. Die vorhandene CLI und der Rust-Kern bleiben unverändert. Der Architekturvorschlag steht in [Cloud Human Workspace](../../docs/cloud-human-workspace.md).

## Lokal ausprobieren

Das Experiment braucht Node.js 22 oder neuer und keine zusätzlichen Pakete. Diese Node-Anforderung gilt nur für das Experiment; für Arbeiten am übrigen Codex-Monorepo gelten dessen eigene Anforderungen.

```bash
cd experimental/human-workspace
node server.mjs
```

Im Browser `http://127.0.0.1:4381/` öffnen. Dieselbe Adresse in einem zweiten Tab öffnen, um den Abgleich zu sehen.

1. Eine Textstelle auswählen und **Stelle festhalten** drücken.
2. Beschreiben, was sich ändern soll. Bei Bedarf ein Bild oder Video anhängen.
3. **Feedback festhalten** drücken. Die Rückmeldung erscheint auch in der zweiten Ansicht.
4. Ein Bild oder Video öffnen. Beim Video den gewünschten Zeitpunkt wählen; optional einen Punkt im Bild anklicken. Die Rückmeldung behält Datei-Hash, Zeitpunkt und Bildposition.
5. Über **Zur Stelle** die Referenz wieder öffnen. Der Videozeitpunkt wird ebenfalls an die andere Ansicht übertragen.

**Text bearbeiten** und **Neue Version speichern** erzeugen eine neue Revision. Alte Rückmeldungen bleiben lesbar und werden als älter markiert. Veraltete Anker werden beim Speichern und beim Erstellen eines Codex-Auftrags abgewiesen. Gleichzeitige Textänderungen erhalten einen sichtbaren Konflikt.

Dateien liegen unter `.local/`, sind aus Git ausgeschlossen und werden nicht an einen Anbieter gesendet. Ein Export enthält Text und Metadaten; die Mediendateien selbst bleiben im lokalen Asset-Verzeichnis. Die Vorschau führt keine KI-Aufgaben aus und startet keine Cloud-Ressourcen.

## Grenzen dieser Version

Die synchronisierte Arbeitsansicht ist ein gemeinsamer Artefaktzustand. Sie ist noch kein übertragener Cloud-Desktop. Videowiedergabe läuft bis zum Festhalten oder Öffnen einer Referenz individuell; es gibt keine Synchronisation jedes Videoframes. Feedback löst in der Oberfläche noch keine KI-Änderung aus.

Der Server ist für eine Person auf einem Mac gedacht. Er bindet ausschließlich an `127.0.0.1`, verwendet eine flüchtige Browser-Sitzung, prüft Host und Herkunft bei Änderungen und liefert keine privaten API-Daten ohne Sitzung. Das ersetzt keine Anmeldung, Autorisierung oder Mandantentrennung eines Cloud-Produkts. Lokale Daten werden von dieser Anwendung **nicht zusätzlich verschlüsselt**. Medien werden anhand einfacher Dateisignaturen eingeschränkt; das ist keine vollständige Dateiprüfung. Höchstens 25 MiB pro Datei und 250 MiB insgesamt. Nur eine Serverinstanz pro Datenverzeichnis betreiben; die Schreibwarteschlange schützt innerhalb eines Prozesses.

## Codex anschließen

```bash
node scripts/check-codex.mjs
```

Prüft den lokalen `initialize`/`initialized`-Handshake. Dieser Befehl startet keinen Modellturn. Ein bestandener Handshake bestätigt weder Modellzugang noch Qualität noch Desktop-Steuerung.

`POST /api/codex-packet` erzeugt einen versionierten Auftrag für einen bestimmten `threadId`. Bei einer angegebenen aktiven `expectedTurnId` verwendet er `turn/steer`, sonst `turn/start`. Die HTTP-Route sendet nichts an Codex. Ein reines JSON-Paket enthält nur Metadaten der Medien.

Ein separater lokaler Adapter ist für einen ausdrücklich gestarteten Review vorbereitet:

```bash
# Nur prüfen und die geplante Übertragung anzeigen:
node scripts/send-feedback.mjs --feedback-id FEEDBACK_UUID

# Erst mit freigegebenem Modellzugang und Budget ausführen:
node scripts/send-feedback.mjs --feedback-id FEEDBACK_UUID --execute
```

Mit `--execute` werden der Kommentar, der zugehörige Text und ausgewählte Bilddaten an Codex über den bestehenden lokalen Login übermittelt. Der Adapter öffnet einen neuen schreibgeschützten Review-Thread und wartet auf dessen Ergebnis. Er setzt weder die Vorschau noch einen Desktop in Betrieb. Bei Videofeedback extrahiert `ffmpeg` genau ein Frame am gewählten Zeitpunkt; das belegt weder Bewegung noch Audio. Andere Videoanhänge bleiben Metadaten. Anhänge mit verändertem Datei-Hash werden zurückgewiesen. Der Adapter lehnt interaktive Server-Anfragen ab, bis eine vollständige Oberfläche für Aktionen und Freigaben existiert. Ein Timeout führt zu keinem automatischen erneuten Modellauftrag. Es gibt noch kein dauerhaftes Zustelljournal und keine automatische Kostengrenze.

## Cloud-Spiegelung vorbereiten

```bash
node scripts/cloud-desktop.mjs
```

Dieser Standardaufruf zeigt nur den Plan und erzeugt keine Ressourcen. Der optionale E2B-Adapter basiert auf der [offiziellen Desktop-Integration](https://docs.e2b.dev/agents/openai-computer-use). Er ist getrennt vom Feedback-Server und wurde hier mit einem Ersatzanbieter getestet; ein echter Anbieteraufruf ist noch nicht bestätigt.

Nach Auswahl eines Kontos, Prüfung der aktuellen Tarife und Freigabe eines Budgets kann der Adapter separat eingerichtet werden:

```bash
npm install --no-save --package-lock=false @e2b/desktop
# E2B_API_KEY über einen lokalen Secret-Mechanismus bereitstellen, nicht in Git oder Chat.
node scripts/cloud-desktop.mjs --start --max-minutes 5
```

Das startet einen leeren Linux-Desktop und eine lokale Viewer-Adresse. Der authentifizierte Stream bleibt im Prozessspeicher und wird nicht geloggt oder in eine Datei geschrieben. Der Desktop endet nach spätestens fünf Minuten; `SIGINT`/`SIGTERM` lösen ebenfalls die Bereinigung aus. Ein harter Prozessabbruch verlässt sich auf den Anbieter-Timeout. Ein Fehler bei `kill()` muss im Anbieterkonto geprüft werden. Die Laufzeitbegrenzung ist **keine finanzielle Ausgabenobergrenze**. Der Anbieteraufruf, seine SDK-Version, das Einbetten des Viewers und das Verhalten bei Verbindungsabbruch brauchen noch einen echten Test. Für die erste Durchführung die dann geprüfte SDK-Version pinnen.

Dieser Pfad verbindet noch keinen Agenten mit dem Desktop, installiert keine persönlichen Apps und überträgt weder lokale Dateien noch Browser-Anmeldungen. Eine spätere Agentenintegration benötigt den gemeinsamen Eingabe-Besitz, frische Screenshots, stabile Koordinaten und einen Datenzugriffsvertrag aus dem Architekturvorschlag.

## Prüfen

```bash
node --test test/*.test.mjs
node scripts/check-codex.mjs
```

Die Tests prüfen Speicherung und doppelte Zustellung, Textkonflikte, veraltete Anker, Sitzungs- und Herkunftsgrenzen, Medienbereiche, präzise Zeitpunkte, Übertragung an eine zweite Ansicht, Cloud-Bereinigung mit einem Ersatzanbieter und den Codex-Nachrichtenablauf mit einem Ersatzprozess. Die Browserprüfung und deren tatsächlicher Umfang werden in `VALIDATION.md` festgehalten. Es gibt keine behauptete Qualitätsgleichheit mit Codex Desktop oder ChatGPT Work.
