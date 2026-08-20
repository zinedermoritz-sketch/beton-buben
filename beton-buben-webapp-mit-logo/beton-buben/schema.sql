-- BETON-BUBEN · STADIONBAU — Datenbankschema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS ranks (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT NOT NULL UNIQUE,
  level                   INTEGER NOT NULL DEFAULT 0,
  kann_aufgaben_zuweisen  INTEGER NOT NULL DEFAULT 0,
  kann_statistiken_sehen  INTEGER NOT NULL DEFAULT 0,
  kann_kalender_erstellen INTEGER NOT NULL DEFAULT 0,
  farbe                   TEXT NOT NULL DEFAULT '#9a9ca3'
);

-- Niedrigster Rang, Pflicht — jedes neue Konto startet hier.
INSERT INTO ranks (name, level, kann_aufgaben_zuweisen, kann_statistiken_sehen, kann_kalender_erstellen, farbe)
  SELECT 'Sklave', 0, 0, 0, 0, '#9a9ca3'
  WHERE NOT EXISTS (SELECT 1 FROM ranks WHERE name = 'Sklave');

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vorname        TEXT NOT NULL,
  nachname       TEXT NOT NULL,
  gamertag       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  password_salt  TEXT NOT NULL,
  konto_id       TEXT NOT NULL,
  erstellt       TEXT NOT NULL,
  aktiv          INTEGER NOT NULL DEFAULT 1,
  freigegeben    INTEGER NOT NULL DEFAULT 0,
  is_admin       INTEGER NOT NULL DEFAULT 0,
  rank_id        INTEGER REFERENCES ranks(id),
  letzter_login  TEXT,
  punkte         INTEGER NOT NULL DEFAULT 0,
  avatar         TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  gamertag      TEXT NOT NULL,
  datum         TEXT NOT NULL,   -- YYYY-MM-DD (Startdatum)
  start         TEXT NOT NULL,   -- ISO-Zeitstempel
  ende          TEXT,            -- ISO-Zeitstempel, NULL solange ON
  dauer_std     REAL,
  status        TEXT NOT NULL,   -- 'ON' | 'OFF'
  quelle        TEXT DEFAULT 'WEB',
  notiz         TEXT,
  session_code  TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  titel               TEXT NOT NULL,
  zustaendig_user_id  INTEGER REFERENCES users(id),
  zustaendig_name     TEXT,
  zugewiesen_von      INTEGER REFERENCES users(id),
  start_zeit          TEXT,
  end_zeit            TEXT,
  status              TEXT NOT NULL DEFAULT 'OFFEN', -- OFFEN | LAEUFT | PAUSIERT | ERLEDIGT
  prioritaet          TEXT NOT NULL DEFAULT 'NORMAL', -- NIEDRIG | NORMAL | HOCH
  notiz               TEXT,
  erstellt_am         TEXT NOT NULL,
  erstellt_von        INTEGER,
  punkte              INTEGER NOT NULL DEFAULT 0
);

-- ---------- PUNKTE-SHOP ----------

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
  status       TEXT NOT NULL DEFAULT 'OFFEN', -- OFFEN | ABGESCHLOSSEN
  erstellt_am  TEXT NOT NULL
);

-- ---------- STADION-BAU (Block-Layer) ----------

CREATE TABLE IF NOT EXISTS stadium_layers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  layer_nr            INTEGER NOT NULL,
  name                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'OFFEN', -- OFFEN | LAEUFT | PAUSIERT | FERTIG
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

-- ---------- BAU-GRUPPEN ----------

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

-- ---------- KALENDER ----------

CREATE TABLE IF NOT EXISTS kalender_eintraege (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  typ            TEXT NOT NULL DEFAULT 'EINTRAG', -- EINTRAG | EVENT
  titel          TEXT NOT NULL,
  beschreibung   TEXT,
  datum          TEXT NOT NULL, -- YYYY-MM-DD
  zeit           TEXT,          -- HH:MM, optional
  erstellt_von   INTEGER REFERENCES users(id),
  ersteller_name TEXT,
  erstellt_am    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kalender_abstimmung (
  entry_id   INTEGER NOT NULL REFERENCES kalender_eintraege(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  antwort    TEXT NOT NULL, -- ZEIT | KEINE_ZEIT
  user_name  TEXT,
  PRIMARY KEY (entry_id, user_id)
);

-- ---------- BENACHRICHTIGUNGEN ----------

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

-- ---------- DOKUMENTE & DATEIEN ----------

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

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_datum ON sessions(datum);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_zustaendig ON tasks(zustaendig_user_id);
CREATE INDEX IF NOT EXISTS idx_layers_status ON stadium_layers(status);
CREATE INDEX IF NOT EXISTS idx_kaeufe_user ON shop_kaeufe(user_id);
CREATE INDEX IF NOT EXISTS idx_kalender_datum ON kalender_eintraege(datum);
CREATE INDEX IF NOT EXISTS idx_benachrichtigungen_user ON benachrichtigungen(user_id, gelesen);
CREATE INDEX IF NOT EXISTS idx_dateien_hochgeladen_am ON dateien(hochgeladen_am);
