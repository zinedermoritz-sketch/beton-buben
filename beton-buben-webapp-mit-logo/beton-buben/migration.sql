-- BETON-BUBEN · STADIONBAU — Migration für BEREITS BESTEHENDE Datenbanken
-- Nur ausführen, wenn die App schon einmal deployed war (also schon Konten/
-- Aufgaben existieren). Bei einer komplett neuen Datenbank stattdessen
-- einfach schema.sql verwenden.
--
-- Im Cloudflare-Dashboard: D1 → deine Datenbank → Reiter "Console" →
-- diesen kompletten Inhalt einfügen und ausführen.

CREATE TABLE IF NOT EXISTS ranks (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT NOT NULL UNIQUE,
  level                   INTEGER NOT NULL DEFAULT 0,
  kann_aufgaben_zuweisen  INTEGER NOT NULL DEFAULT 0,
  kann_statistiken_sehen  INTEGER NOT NULL DEFAULT 0,
  farbe                   TEXT NOT NULL DEFAULT '#9a9ca3'
);

INSERT INTO ranks (name, level, kann_aufgaben_zuweisen, kann_statistiken_sehen, farbe)
  SELECT 'Sklave', 0, 0, 0, '#9a9ca3'
  WHERE NOT EXISTS (SELECT 1 FROM ranks WHERE name = 'Sklave');

ALTER TABLE users ADD COLUMN freigegeben INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN rank_id INTEGER REFERENCES ranks(id);

-- Bestehende Konten automatisch freigeben (sie waren ja schon aktiv) und
-- allesamt auf "Sklave" setzen — Ränge kannst du danach in der Verwaltung
-- frei verteilen. Der Admin bleibt Admin und hat ohnehin alle Rechte.
UPDATE users SET freigegeben = 1 WHERE freigegeben = 0;
UPDATE users SET rank_id = (SELECT id FROM ranks WHERE name = 'Sklave') WHERE rank_id IS NULL;

ALTER TABLE tasks ADD COLUMN zugewiesen_von INTEGER REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_tasks_zustaendig ON tasks(zustaendig_user_id);
