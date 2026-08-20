-- BETON-BUBEN · STADIONBAU — Migration v3 für BEREITS BESTEHENDE Datenbanken
-- Fügt die Tabelle für den "Dokumente & Dateien"-Reiter hinzu.
-- Nur ausführen, wenn die App schon vorher lief (schema.sql bzw. migration.sql /
-- migration_v2.sql wurden schon einmal ausgeführt). Bei einer komplett neuen
-- Datenbank reicht stattdessen ganz normal schema.sql.
--
-- Im Cloudflare-Dashboard: D1 → deine Datenbank → Reiter "Console" →
-- diesen kompletten Inhalt einfügen und ausführen.
--
-- WICHTIG: Für den Dateien-Reiter brauchst du zusätzlich einen R2-Bucket,
-- siehe README.md ("R2-Bucket für Dateien anlegen").

CREATE TABLE IF NOT EXISTS dateien (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  dateiname        TEXT NOT NULL,
  beschreibung     TEXT,
  groesse_bytes    INTEGER NOT NULL,
  content_type     TEXT,
  r2_key           TEXT NOT NULL UNIQUE,
  hochgeladen_von  INTEGER REFERENCES users(id),
  hochgeladen_name TEXT,
  hochgeladen_am   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dateien_hochgeladen_am ON dateien(hochgeladen_am);
