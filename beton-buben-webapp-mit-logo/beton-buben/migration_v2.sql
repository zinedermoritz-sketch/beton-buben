-- BETON-BUBEN · STADIONBAU — Migration v2 für BEREITS BESTEHENDE Datenbanken
-- Fügt Punkte-Shop, Stadion-Bau, Bau-Gruppen, Kalender & Benachrichtigungen hinzu.
-- Nur ausführen, wenn die App schon vorher lief (schema.sql bzw. migration.sql
-- wurden schon einmal ausgeführt). Bei einer komplett neuen Datenbank reicht
-- stattdessen ganz normal schema.sql.
--
-- Im Cloudflare-Dashboard: D1 → deine Datenbank → Reiter "Console" →
-- diesen kompletten Inhalt einfügen und ausführen.

ALTER TABLE ranks ADD COLUMN kann_kalender_erstellen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN punkte INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN avatar TEXT;
ALTER TABLE tasks ADD COLUMN punkte INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS shop_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  titel         TEXT NOT NULL,
  beschreibung  TEXT,
  kosten        INTEGER NOT NULL,
  aktiv         INTEGER NOT NULL DEFAULT 1,
  erstellt_von  INTEGER REFERENCES users(id),
  erstellt_am   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_kaeufe (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER REFERENCES shop_items(id),
  item_titel   TEXT NOT NULL,
  kosten       INTEGER NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  user_name    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'OFFEN',
  erstellt_am  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stadium_layers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  layer_nr            INTEGER NOT NULL,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'OFFEN',
  zustaendig_user_id  INTEGER REFERENCES users(id),
  zustaendig_name     TEXT,
  zugewiesen_von      INTEGER REFERENCES users(id),
  punkte              INTEGER NOT NULL DEFAULT 0,
  notiz               TEXT,
  start_zeit          TEXT,
  end_zeit            TEXT,
  erstellt_am         TEXT NOT NULL,
  erstellt_von        INTEGER
);

CREATE TABLE IF NOT EXISTS bau_gruppen (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  farbe         TEXT NOT NULL DEFAULT '#5f8fc4',
  beschreibung  TEXT,
  erstellt_von  INTEGER REFERENCES users(id),
  erstellt_am   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bau_gruppen_mitglieder (
  gruppe_id  INTEGER NOT NULL REFERENCES bau_gruppen(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (gruppe_id, user_id)
);

CREATE TABLE IF NOT EXISTS kalender_eintraege (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  typ            TEXT NOT NULL DEFAULT 'EINTRAG',
  titel          TEXT NOT NULL,
  beschreibung   TEXT,
  datum          TEXT NOT NULL,
  zeit           TEXT,
  erstellt_von   INTEGER REFERENCES users(id),
  ersteller_name TEXT,
  erstellt_am    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kalender_abstimmung (
  entry_id   INTEGER NOT NULL REFERENCES kalender_eintraege(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  antwort    TEXT NOT NULL,
  user_name  TEXT,
  PRIMARY KEY (entry_id, user_id)
);

CREATE TABLE IF NOT EXISTS benachrichtigungen (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  typ          TEXT NOT NULL,
  titel        TEXT NOT NULL,
  text         TEXT,
  link         TEXT,
  gelesen      INTEGER NOT NULL DEFAULT 0,
  erstellt_am  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_layers_status ON stadium_layers(status);
CREATE INDEX IF NOT EXISTS idx_kaeufe_user ON shop_kaeufe(user_id);
CREATE INDEX IF NOT EXISTS idx_kalender_datum ON kalender_eintraege(datum);
CREATE INDEX IF NOT EXISTS idx_benachrichtigungen_user ON benachrichtigungen(user_id, gelesen);
