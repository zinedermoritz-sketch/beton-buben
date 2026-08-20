# BETON-BUBEN · STADIONBAU

Web-App zur Zeiterfassung & Aufgabenplanung für die Bau-Crew — ersetzt die
alte Excel/VBA-Datei. Läuft komplett auf **Cloudflare Pages** (Frontend +
Backend als "Pages Functions") mit **Cloudflare D1** (Datenbank). Kein
eigener Server nötig, keine Kosten im Free-Tier für den üblichen Gebrauch.

## Was die App kann

- **Login / Registrierung** mit echten, sicher gehashten Passwörtern
  (PBKDF2, nicht im Klartext)
- **Konto-Freigabe**: Neue Registrierungen müssen erst von einem Admin
  freigeschaltet werden, bevor sich die Person einloggen kann
- **Online-Zeit-Schalter** (ON/OFF) mit Live-Stoppuhr
- **Aufgabenliste** (anlegen, starten, pausieren, erledigen, löschen),
  optional einer Person zugewiesen (nur mit entsprechender Rang-Berechtigung).
  **Nur der Admin** kann beim Anlegen einer Aufgabe die **Punktzahl**
  festlegen, die es beim Erledigen gibt
- **Punkte-Shop**: Der Admin legt im Webinterface Angebote an (Titel,
  Beschreibung, Punktekosten). Jeder kann sich mit gesammelten Punkten
  etwas "kaufen" — der Kauf landet als offene Bestellung, die der Admin
  als erledigt markiert, sobald er sie geliefert hat
- **Stadion-Bau**: eigenes Abteil, in dem die Block-Layer des Stadions als
  Aufgaben angelegt werden (mit Zuweisung, Punkten, Start/Pause/Fertig).
  Auf dem Dashboard und im Stadion-Bau-Abteil selbst wird das Stadion als
  gestapelte Blocklagen-Grafik dargestellt — **jede fertiggestellte Layer
  färbt sich ein**
- **Bau-Gruppen**: beliebig viele Trupps anlegen, Mitglieder zuweisen/entfernen
- **Kalender**: Einträge & Events; ab einer bestimmten Rang-Berechtigung
  (oder Admin) können neue Einträge erstellt werden. Bei Events kann jeder
  abstimmen, ob er Zeit hat
- **Dokumente & Dateien**: eigener Reiter, in dem **nur der Admin** Dateien
  hochladen kann (Baupläne, PDFs, Bilder, ZIPs, …) — die ganze Crew sieht
  die Liste und kann herunterladen. Dateien landen in Cloudflare R2, nicht
  in der Datenbank
- **Avatare**: jede Person kann ihren Minecraft-Kopf durch ein Emoji ersetzen
- **Benachrichtigungen**: Glocke oben rechts mit ungelesen-Zähler +
  Browser-Push-Benachrichtigungen (auch wenn der Tab im Hintergrund läuft),
  u. a. bei: Aufgabe zugewiesen, Aufgabe erledigt, Stadion-Layer zugewiesen,
  Stadion-Layer fertig, neue Shop-Bestellung, Shop-Bestellung ausgeliefert
- **Kodex**: eine spaßige, fiktive Unternehmens-"Verfassung" der Beton-Buben
- **Ränge mit Berechtigungen**: beliebig viele Ränge, je mit den Rechten
  „Aufgaben zuweisen", „Statistik/Log sehen" und „Kalender erstellen".
  Der niedrigste Rang heißt immer **„Sklave"** (Standard für neue Konten)
- **Zeitlog** aller abgeschlossenen Sessions + CSV-Export
- **Statistik** (ab passendem Rang oder für Admin): Profile (Gesamtstunden,
  Punkte, erledigte Aufgaben) & Aktivitätslog (wer war wann online)
- **Rangliste** nach Gesamtstunden, Sessions, Ø-Session, Punkten, ON/OFF-Status
- **Baufortschritts-Abzeichen** (🧱 Grundstein → 🏆 Stadion eröffnet) je nach
  Gesamtstunden
- **Verwaltung** (nur Admin = erster registrierter Account): Konten
  freigeben/ablehnen/sperren, Ränge vergeben, Ränge samt Berechtigungen
  anlegen/bearbeiten/löschen

## Architektur

```
public/          → Frontend (HTML/CSS/JS, keine Build-Tools nötig)
functions/api/   → Backend-API als Cloudflare Pages Function
schema.sql       → Datenbankschema für Cloudflare D1 (komplette, neue DB)
migration.sql    → Migration von der Ur-Version (Ränge, Freigabe) auf v1
migration_v2.sql → Migration auf v2 (Punkte-Shop, Stadion-Bau, Bau-Gruppen,
                    Kalender, Benachrichtigungen)
migration_v3.sql → Migration auf die aktuelle Version (Dokumente & Dateien)
wrangler.toml    → Konfiguration (D1- und R2-Bindung)
```

## Kostenlos hosten — Schritt für Schritt

Alles läuft auf Cloudflare, im **kostenlosen Free-Tier**. Du brauchst dafür
nur einen Cloudflare-Account — keine eigene Server-Miete, kein Kreditkarten-
Abo (Cloudflare verlangt für R2 zwar eine hinterlegte Zahlungsmethode, siehe
Schritt 3, berechnet aber im beschriebenen Umfang nichts).

### 1. Cloudflare-Account anlegen

Auf **dash.cloudflare.com** kostenlos registrieren (falls noch nicht
vorhanden). Kein Zahlungsmittel nötig für diesen ersten Schritt.

### 2. D1-Datenbank anlegen

Im Dashboard: **Workers & Pages → D1 SQL Database → Create database**.
Name z. B. `beton-buben-db`. Danach im Reiter **Console** den kompletten
Inhalt von `schema.sql` einfügen und ausführen — das legt alle Tabellen an.

> **Schon mal deployed?** Falls du diese App (oder eine ältere Version)
> schon einmal aufgesetzt hattest:
> - Ur-Version ohne Ränge/Freigabe? Erst `migration.sql`, dann
>   `migration_v2.sql`, dann `migration_v3.sql` ausführen.
> - Version mit Rängen/Freigabe, aber noch ohne Punkte-Shop/Stadion-Bau?
>   Nur `migration_v2.sql`, dann `migration_v3.sql` ausführen.
> - Version mit Punkte-Shop/Stadion-Bau/Kalender, aber noch ohne
>   Dokumente-Reiter? Nur `migration_v3.sql` ausführen.
> - Führe **niemals** `schema.sql` auf einer Datenbank aus, die schon
>   Konten enthält — das ist nur für eine komplett neue, leere Datenbank.

### 3. R2-Bucket für Dateien anlegen (für den „Dokumente & Dateien"-Reiter)

Im Dashboard: **R2 Object Storage → Create bucket**, Name z. B.
`beton-buben-dateien` (muss zu `bucket_name` in `wrangler.toml` passen,
oder du passt `wrangler.toml` an den von dir gewählten Namen an).

Cloudflare verlangt beim ersten R2-Bucket eine hinterlegte Zahlungsmethode
(Verifizierung), **berechnet aber nichts**, solange du im Free-Tier bleibst:
10 GB Speicher und großzügige Lese-/Schreibkontingente pro Monat, dazu
**keine Kosten fürs Herunterladen** (kein Egress-Fee) — für eine Bau-Crew
mit Bauplänen/PDFs/Bildern reicht das bei Weitem.

Wenn du den Dateien-Reiter nicht nutzen willst, kannst du diesen Schritt
und den R2-Bucket-Block in `wrangler.toml` auch einfach weglassen — der
Rest der App läuft ohne R2 ganz normal weiter (nur „Dokumente & Dateien"
zeigt dann einen Hinweis, dass kein Speicher eingerichtet ist).

### 4. Projekt hochladen

Entweder den ganzen Projektordner in ein neues **GitHub-Repository** pushen,
oder im Dashboard direkt **Workers & Pages → Create → Pages → Upload assets**
für den Direkt-Upload nutzen (kein GitHub nötig).

### 5. Pages-Projekt erstellen

**Workers & Pages → Create → Pages → Connect to Git** (Repo auswählen)
oder eben **Upload assets**.

Build-Einstellungen:
- Build command: *(leer lassen)*
- Build output directory: `public`

### 6. D1 und R2 mit dem Pages-Projekt verknüpfen

Im Pages-Projekt: **Settings → Functions**
- **D1 database bindings** → Variable name: `DB` → Datenbank:
  `beton-buben-db` auswählen.
- **R2 bucket bindings** → Variable name: `FILES` → Bucket:
  `beton-buben-dateien` auswählen.

### 7. Secret für die Anmeldung setzen

Im Pages-Projekt: **Settings → Environment variables** →
Variable `JWT_SECRET` hinzufügen, Wert: irgendein langer, zufälliger Text
(z. B. mit einem Passwort-Generator erzeugt). Als **Secret** markieren.
Für **Production** und **Preview** setzen.

### 8. Deployen

Bei Git-Verbindung passiert das automatisch bei jedem Push. Bei
Direkt-Upload klickst du einfach auf **Deploy**.

Fertig — die App läuft kostenlos unter deiner `*.pages.dev`-Adresse (oder
deiner eigenen Domain, wenn du sie im Pages-Projekt hinterlegst).

### 9. Erster Account = Admin

Der allererste Account, der sich registriert, wird automatisch zum Admin
(sichtbar am Menüpunkt „Verwaltung") und ist sofort freigeschaltet. Am
besten also selbst zuerst registrieren, bevor der Link an die Crew geht.

Jede weitere Registrierung landet zunächst als „wartet auf Freigabe" in
der Verwaltung — erst nach dem Klick auf **Freigeben** kann sich die
Person einloggen. Dort verteilst du auch die Ränge (Standard: „Sklave").

### 10. Stadion-Layer, Punkte-Shop, Ränge & Dokumente einrichten

Nach dem Deploy als Admin einloggen und:
- Unter **Aufgaben**: Aufgaben direkt über das Formular anlegen — nur du
  als Admin siehst dabei das Punkte-Feld.
- Unter **Stadion-Bau**: die Block-Layer anlegen (Name, optional zuweisen,
  optional Punkte). Jede fertiggestellte Layer färbt sich in der
  gestapelten Stadion-Grafik ein.
- Unter **Punkte-Shop**: Angebote mit Punktekosten anlegen.
- Unter **Dokumente & Dateien**: Dateien hochladen — nur du als Admin
  siehst das Upload-Formular, alle anderen sehen nur „Download".
- Unter **Verwaltung → Ränge**: bei Bedarf Rechte „Kalender erstellen"
  bzw. „Aufgaben zuweisen" an höhere Ränge vergeben.

## Lokale Entwicklung (optional)

```bash
npm install -g wrangler
wrangler d1 execute beton-buben-db --local --file=schema.sql
wrangler pages dev public --d1=DB=beton-buben-db
```

## Hinweise

- Passwörter werden mit PBKDF2 (100.000 Iterationen, SHA-256, individueller
  Salt) gehasht — sie landen nie im Klartext in der Datenbank.
- Die Anmeldung nutzt ein signiertes Token (HMAC mit `JWT_SECRET`), das im
  Browser gespeichert wird — kein separates Session-Backend nötig.
- Browser-Benachrichtigungen (Notification API) fragen beim ersten Login
  einmalig die Berechtigung ab; danach poppen neue Benachrichtigungen auch
  auf, wenn der Tab im Hintergrund/minimiert ist.
- Die Aufgabenliste ist bewusst für die ganze Crew gemeinsam sichtbar
  (wie vorher in Excel), nicht pro Person getrennt.
