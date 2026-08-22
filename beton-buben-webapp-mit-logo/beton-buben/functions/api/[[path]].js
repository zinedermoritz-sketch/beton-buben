// BETON-BUBEN · STADIONBAU — Backend-API
// Läuft als Cloudflare Pages Function unter /api/*
// Benötigt: D1-Binding "DB" + Secret "JWT_SECRET" (siehe README.md)
//
// WICHTIG — KEINE D1-MIGRATION MEHR NÖTIG!
// Erwartete/verbrauchte Zeit, Liste der zugewiesenen Spieler-IDs, ein
// optionaler Link, die Verknüpfung zu einem Litematica-Block-Layer, der
// geplante Termin (Datum + Uhrzeit) UND jetzt auch die geplante DAUER eines
// Kalendereintrags/Events werden als kleines JSON-Päckchen in ein bereits
// vorhandenes Textfeld gepackt:
//   - Aufgaben:            im Feld "notiz"
//   - Stadion-Layer:        im Feld "name", angehängt hinter einem unsichtbaren
//                            Trennzeichen, sodass der eigentliche Layer-Name beim
//                            Anzeigen sauber abgetrennt bleibt.
//   - Kalender-Einträge:    im Feld "beschreibung", genau wie bei Layern hinter
//                            einem unsichtbaren Trennzeichen angehängt.
// Siehe packMeta() / unpackMeta() weiter unten für die Details.
//
// NEU (Schematic-Platzierung):
//   Das Frontend zeigt ein Dashboard-Panel, in dem der Admin X/Y/Z-Koordinaten
//   für die Schematic-Platzierung einträgt (api("/schematic")). Dieser
//   Endpunkt fehlte bisher komplett im Backend — dadurch schlug der
//   Promise.all() beim Laden der Übersicht mit einem 404 fehl und das
//   Dashboard blieb dauerhaft bei "Lade Baustelle …" hängen. Behoben, indem
//   die Tabelle beim ersten Zugriff automatisch angelegt wird (kein manuelles
//   D1-Migrationsskript nötig) und /schematic GET/POST bedient wird.
//
// NEU (Kalender-Dauer):
//   Kalender-Einträge/Events können jetzt eine "erwartete Dauer" bekommen
//   (genau wie Aufgaben/Layer über die HH:MM-Eingabe). Wird als "erw"
//   (Sekunden) im selben Meta-Päckchen im Feld "beschreibung" gespeichert.
//   Der Zeitstrahl-Tab zeigt Kalender-Einträge/Events jetzt ebenfalls als
//   Balken an — in eigenen Farben (Kalender-Eintrag: amber, Event: lila),
//   damit sie sich optisch von Aufgaben/Layern abheben.
//
// NEU (3-Tage-Plan editierbar):
//   Der Text im "📋 3-Tage-Plan"-Tab liegt jetzt in einer eigenen kleinen
//   Tabelle (plan_3tage, id=1) statt hart im Frontend zu stehen. Admins
//   können ihn direkt auf der Webseite bearbeiten und speichern — siehe
//   ensurePlanTable()/DEFAULT_PLAN_3TAGE sowie die Endpunkte GET/POST
//   /plan3tage weiter unten. Auch diese Tabelle wird beim ersten Zugriff
//   automatisch angelegt, keine manuelle D1-Migration nötig.
//
// NEU (Vorschläge-Route ergänzt):
//   Das Frontend hatte bereits einen kompletten "💡 Vorschläge"-Tab
//   (GET/POST /vorschlaege, POST /vorschlaege/:id/entscheiden,
//   DELETE /vorschlaege/:id), aber im Backend fehlten die passenden
//   Endpunkte komplett — dadurch lief jede Anfrage ins Leere (404) und der
//   Tab blieb für immer bei "Lade Vorschläge …" hängen. Behoben, inkl.
//   automatischer Tabellenerstellung (vorschlaege) beim ersten Zugriff,
//   genau wie bei plan_3tage/schematic_platzierung — keine manuelle
//   D1-Migration nötig.

import { BLOCK_LAYERS } from "./block-layers-data.js";

// ---------- Hilfsfunktionen ----------

const enc = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function randHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltHex) {
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return JSON.parse(atob(str));
}

async function makeToken(secret, payload) {
  const body = b64url({ ...payload, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 });
  const sig = await hmac(secret, body);
  return `${body}.${sig}`;
}

async function verifyToken(secret, token) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await hmac(secret, body);
  if (expected !== sig) return null;
  const payload = unb64url(body);
  if (payload.exp < Date.now()) return null;
  return payload;
}

function getBearer(request) {
  const h = request.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// Holt den Rang eines Nutzers (mit Fallback auf ein leeres Berechtigungsobjekt).
async function getRank(env, rankId) {
  if (!rankId) return null;
  return env.DB.prepare("SELECT * FROM ranks WHERE id = ?").bind(rankId).first();
}

async function sklaveRankId(env) {
  const r = await env.DB.prepare("SELECT id FROM ranks WHERE name = 'Sklave'").first();
  return r ? r.id : null;
}

function hasPerm(user, rank, key) {
  if (user && user.is_admin) return true;
  return !!(rank && rank[key]);
}

async function requireUser(request, env) {
  const token = getBearer(request);
  const payload = await verifyToken(env.JWT_SECRET, token);
  if (!payload) return null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND aktiv = 1 AND freigegeben = 1").bind(payload.uid).first();
  if (!user) return null;
  user.rank = await getRank(env, user.rank_id);
  return user;
}

function avatarFor(u) {
  if (u.avatar) return { typ: "emoji", wert: u.avatar };
  return { typ: "kopf", wert: `https://mc-heads.net/avatar/${encodeURIComponent(u.gamertag)}/64` };
}

const BADGES = [
  { std: 1, name: "Grundstein gelegt", icon: "🧱" },
  { std: 5, name: "Fundament", icon: "🏗️" },
  { std: 10, name: "Rohbau", icon: "🧊" },
  { std: 25, name: "Tribünen stehen", icon: "🪑" },
  { std: 50, name: "Flutlicht an", icon: "💡" },
  { std: 100, name: "Dach drauf", icon: "🏟️" },
  { std: 200, name: "Stadion eröffnet", icon: "🏆" },
];
function badgeFor(std) {
  let cur = null;
  for (const b of BADGES) if (std >= b.std) cur = b;
  const next = BADGES.find((b) => b.std > std) || null;
  return { current: cur, next };
}

// ---------- Meta-Encoding ohne D1-Migration ----------
// Ein kleines JSON-Objekt {erw, verb, ids, link, blk, datum, zeit} wird
// hinter einem unsichtbaren Marker an ein vorhandenes Textfeld angehängt.
//   erw   = erwartete Sekunden (Zielzeit für den Countdown / Dauer im Zeitstrahl)
//   verb  = bereits verbrauchte Sekunden aus abgeschlossenen LAEUFT-Phasen
//   ids   = Liste der User-IDs, die aktuell zugewiesen sind (Mehrfach-Zuweisung)
//   link  = optionaler Link (z. B. Bauplan/Video) — nur bei Aufgaben genutzt
//   blk   = Nummer des verknüpften Litematica-Block-Layers — nur bei
//           Stadion-Layern genutzt (0 = keine Verknüpfung)
//   datum = geplantes Datum im Format YYYY-MM-DD ("" = kein Termin geplant)
//   zeit  = geplante Uhrzeit im Format HH:MM ("" = keine Uhrzeit gesetzt)
// Bei Kalender-Einträgen wird aus diesem Päckchen nur "erw" (Dauer) genutzt.
// Ist gar nichts davon gesetzt, bleibt das Feld unverändert/sauber.
const META_MARK = "\u2063ZM\u2063";

function packMeta(baseText, meta) {
  const base = baseText || "";
  const erw = Math.max(0, Math.round((meta && meta.erw) || 0));
  const verb = Math.max(0, Math.round((meta && meta.verb) || 0));
  const ids = Array.isArray(meta && meta.ids) ? [...new Set(meta.ids.map(Number).filter(Boolean))] : [];
  const link = meta && meta.link ? String(meta.link).trim().slice(0, 500) : "";
  const blk = Math.max(0, Math.round((meta && meta.blk) || 0));
  const datum = meta && meta.datum ? String(meta.datum).trim().slice(0, 10) : "";
  const zeit = meta && meta.zeit ? String(meta.zeit).trim().slice(0, 5) : "";
  if (!erw && !verb && !ids.length && !link && !blk && !datum && !zeit) return base;
  return `${base}${META_MARK}${JSON.stringify({ erw, verb, ids, link, blk, datum, zeit })}`;
}

function unpackMeta(text) {
  const raw = text || "";
  const idx = raw.indexOf(META_MARK);
  if (idx === -1) return { base: raw, erw: 0, verb: 0, ids: [], link: "", blk: 0, datum: "", zeit: "" };
  const base = raw.slice(0, idx);
  let m = {};
  try { m = JSON.parse(raw.slice(idx + META_MARK.length)); } catch { /* ignore */ }
  return {
    base,
    erw: Math.max(0, parseInt(m.erw) || 0),
    verb: Math.max(0, parseInt(m.verb) || 0),
    ids: Array.isArray(m.ids) ? m.ids.map(Number).filter(Boolean) : [],
    link: typeof m.link === "string" ? m.link.slice(0, 500) : "",
    blk: Math.max(0, parseInt(m.blk) || 0),
    datum: typeof m.datum === "string" ? m.datum.slice(0, 10) : "",
    zeit: typeof m.zeit === "string" ? m.zeit.slice(0, 5) : "",
  };
}

async function totalHoursFor(env, gamertag) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(dauer_std),0) AS h FROM sessions WHERE gamertag = ? AND status = 'OFF'"
  )
    .bind(gamertag)
    .first();
  return row.h || 0;
}

async function todayHoursFor(env, gamertag) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(dauer_std),0) AS h FROM sessions WHERE gamertag = ? AND status = 'OFF' AND datum = ?"
  )
    .bind(gamertag, todayStr())
    .first();
  return row.h || 0;
}

async function openSessionFor(env, gamertag) {
  return env.DB.prepare("SELECT * FROM sessions WHERE gamertag = ? AND status = 'ON' ORDER BY id DESC LIMIT 1")
    .bind(gamertag)
    .first();
}

async function completedTasksCountFor(env, userId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM tasks WHERE zustaendig_user_id = ? AND status = 'ERLEDIGT'"
  )
    .bind(userId)
    .first();
  return row.c || 0;
}

// ---------- Mehrfach-Zuweisung (Aufgaben & Layer) — OHNE eigene D1-Tabellen ----------
// Statt Junction-Tabellen (task_zuweisungen / layer_zuweisungen), die eine
// Migration voraussetzen würden, steckt die Liste der zugewiesenen User-IDs
// im Meta-Päckchen des jeweiligen Textfelds (siehe packMeta/unpackMeta oben).

// Holt volle Spieler-Datensätze zu einer Liste von IDs (für Anzeige).
async function getUsersByIds(env, ids) {
  const uniq = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!uniq.length) return [];
  const placeholders = uniq.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, vorname, nachname, gamertag, avatar FROM users WHERE id IN (${placeholders}) ORDER BY vorname`
  )
    .bind(...uniq)
    .all();
  const anteil = results.length ? Math.round(100 / results.length) : 100;
  return results.map((r) => ({
    id: r.id,
    vorname: r.vorname,
    nachname: r.nachname,
    gamertag: r.gamertag,
    anteil,
    avatar: avatarFor(r),
  }));
}

// --- Aufgaben (Meta im Feld "notiz") ---

async function taskMeta(env, taskId) {
  const row = await env.DB.prepare("SELECT notiz FROM tasks WHERE id = ?").bind(taskId).first();
  return unpackMeta(row ? row.notiz : "");
}

async function setTaskMeta(env, taskId, patch) {
  const cur = await taskMeta(env, taskId);
  const merged = {
    erw: patch.erw !== undefined ? patch.erw : cur.erw,
    verb: patch.verb !== undefined ? patch.verb : cur.verb,
    ids: patch.ids !== undefined ? patch.ids : cur.ids,
    link: patch.link !== undefined ? patch.link : cur.link,
    datum: patch.datum !== undefined ? patch.datum : cur.datum,
    zeit: patch.zeit !== undefined ? patch.zeit : cur.zeit,
  };
  const notiz = packMeta("", merged);
  await env.DB.prepare("UPDATE tasks SET notiz = ? WHERE id = ?").bind(notiz, taskId).run();
  return merged;
}

async function getTaskAssignees(env, taskId) {
  const meta = await taskMeta(env, taskId);
  return getUsersByIds(env, meta.ids);
}
async function setTaskAssignees(env, taskId, userIds) {
  await setTaskMeta(env, taskId, { ids: userIds });
}
async function taskAssigneeIds(env, taskId) {
  const meta = await taskMeta(env, taskId);
  return meta.ids;
}
async function isAssignedToTask(env, task, userId) {
  if (task.zustaendig_user_id === userId) return true;
  const ids = await taskAssigneeIds(env, task.id);
  return ids.includes(userId);
}

// --- Stadion-Layer (Meta im Feld "name") ---

async function layerMetaFull(env, layerId) {
  const row = await env.DB.prepare("SELECT name FROM stadium_layers WHERE id = ?").bind(layerId).first();
  return unpackMeta(row ? row.name : "");
}

async function setLayerMeta(env, layerId, patch) {
  const cur = await layerMetaFull(env, layerId);
  const merged = {
    base: patch.base !== undefined ? patch.base : cur.base,
    erw: patch.erw !== undefined ? patch.erw : cur.erw,
    verb: patch.verb !== undefined ? patch.verb : cur.verb,
    ids: patch.ids !== undefined ? patch.ids : cur.ids,
    blk: patch.blk !== undefined ? patch.blk : cur.blk,
    datum: patch.datum !== undefined ? patch.datum : cur.datum,
    zeit: patch.zeit !== undefined ? patch.zeit : cur.zeit,
  };
  const name = packMeta(merged.base, merged);
  await env.DB.prepare("UPDATE stadium_layers SET name = ? WHERE id = ?").bind(name, layerId).run();
  return merged;
}

async function getLayerAssignees(env, layerId) {
  const meta = await layerMetaFull(env, layerId);
  return getUsersByIds(env, meta.ids);
}
async function setLayerAssignees(env, layerId, userIds) {
  await setLayerMeta(env, layerId, { ids: userIds });
}
async function layerAssigneeIds(env, layerId) {
  const meta = await layerMetaFull(env, layerId);
  return meta.ids;
}
async function isAssignedToLayer(env, layer, userId) {
  if (layer.zustaendig_user_id === userId) return true;
  const ids = await layerAssigneeIds(env, layer.id);
  return ids.includes(userId);
}

// Hängt an eine Liste von Aufgaben/Layern die jeweilige assignees-Liste sowie die
// (aus dem Meta-Feld dekodierte) erwartete/verbrauchte Zeit, den Link (Aufgaben),
// die verknüpfte Block-Layer-Nummer (Stadion-Layer) UND den geplanten Termin
// (Datum + Uhrzeit) an.
async function attachTaskAssignees(env, tasks) {
  const out = [];
  for (const t of tasks) {
    const { erw, verb, ids, link, datum, zeit } = unpackMeta(t.notiz);
    out.push({
      ...t,
      assignees: await getUsersByIds(env, ids),
      erwartete_sekunden: erw,
      verbrauchte_sekunden: verb,
      link: link || "",
      geplant_datum: datum || "",
      geplant_zeit: zeit || "",
    });
  }
  return out;
}
async function attachLayerAssignees(env, layers) {
  const out = [];
  for (const l of layers) {
    const { base, erw, verb, ids, blk, datum, zeit } = unpackMeta(l.name);
    out.push({
      ...l,
      name: base,
      assignees: await getUsersByIds(env, ids),
      erwartete_sekunden: erw,
      verbrauchte_sekunden: verb,
      blocklayer_nr: blk || 0,
      geplant_datum: datum || "",
      geplant_zeit: zeit || "",
    });
  }
  return out;
}

// Verteilt Punkte beim Abschluss gleichmäßig auf alle Zuständigen (oder an den
// einzelnen Zuständigen/den ausführenden Nutzer, falls keine Mehrfach-Zuweisung besteht).
async function verteilePunkte(env, punkte, assignees, fallbackUserId) {
  if (!punkte || punkte <= 0) return;
  if (assignees && assignees.length) {
    const anteil = Math.floor(punkte / assignees.length);
    let rest = punkte - anteil * assignees.length;
    for (const a of assignees) {
      const teil = anteil + (rest > 0 ? 1 : 0);
      if (rest > 0) rest -= 1;
      await addPunkte(env, a.id, teil);
    }
  } else if (fallbackUserId) {
    await addPunkte(env, fallbackUserId, punkte);
  }
}

// ---------- Schematic-Platzierung ----------
// Eine einzige feste Zeile (id=1) mit den X/Y/Z-Koordinaten, an denen die
// Schematic im Bauplan platziert werden soll. Die Tabelle wird beim ersten
// Zugriff automatisch angelegt — dadurch ist keine manuelle D1-Migration
// nötig, egal auf welchem Stand die bestehende Datenbank ist.
async function ensureSchematicTable(env) {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS schematic_platzierung (id INTEGER PRIMARY KEY CHECK (id = 1), x INTEGER, y INTEGER, z INTEGER)"
  );
}

function parseCoordValue(raw) {
  if (raw === "" || raw === undefined || raw === null) return null;
  const n = parseInt(raw);
  return Number.isFinite(n) ? n : null;
}

// ---------- 3-Tage-Plan (editierbarer Text) ----------
// Eine einzige feste Zeile (id=1) mit dem kompletten Plan-Text. Wird beim
// ersten Zugriff automatisch angelegt (keine manuelle D1-Migration nötig).
// Formatierungs-Legende (siehe auch app.js/renderPlanTextHtml):
//   # Titel         → große Überschrift
//   ## Tag-Titel    → Tages-Überschrift
//   @ Zeitmarke     → zentrierte Zeitangabe
//   > Hinweis/Pause → hervorgehobener Hinweis
//   ! Wichtig       → auffällige Warnung/Erinnerung
//   Leerzeile       → zusätzlicher Abstand
async function ensurePlanTable(env) {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS plan_3tage (id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT, aktualisiert_am TEXT, aktualisiert_von TEXT)"
  );
}

const DEFAULT_PLAN_3TAGE = `# 18:00 Start

## Tag 1

@ Start
Bauplatz finden (mit Villager-Plains) — max. 30 Min.
Breeder (ChargedJakob), Dia-Stuff für beide (Zidinator) — max. 45 Min.
Trading Hall ausgraben (beide) — max. 20 Min.
Farmen für Lecterns & Smithing Tables (Zidinator), Trading-Hall-Essentials machen und Tiere sammeln (ChargedJakob) — max. 20 Min.

> Klo-Pause — max. 5 Min.

@ Ungefähr 20:00
Cobble-Gen-Farmen bauen (ChargedJakob), Zombies ansammeln + Nametag ×4 (Zidinator) + Blöcke + Villager sammeln (32 Stück) — 3 Std.

> Wenn alles fertig und gut in der Zeit liegt: Tratsch-Pause, max. 15–30 Min. mit anderen

@ Ungefähr 23:30
Zidinator baut die Eisenfarm, währenddessen holt ChargedJakob Blöcke für den Supersmelter + hilft bei Zombie- und Villager-Farm — Supersmelter eventuell mitbauen — 3 Std.

@ Ungefähr 02:30
ChargedJakob geht schlafen = Eisenfarm läuft AFK weiter
Zidinator macht Trades (ALLE — volles Programm) — 2,5 Std.

@ Ungefähr 05:00 = Tag 1 Ende!!!

## Tag 2

! Wecker auf 09:00!!!

Tridents-Farm läuft über den ganzen Tag
Gabriel-Discord-Meetup = gutes Morgenbier

@ 9:30 — Zusammenkunft
Netherit minen + volle Verzauberungen (beide) — max. 1,5 Std.
Bone-Meal-Farm bauen inkl. Blöcke (ChargedJakob) / Redstone-Farm farmen & bauen — max. 2,5 Std.

> 13:30 Mittagessen — max. 45 Min.

@ Ungefähr 14:15
Concrete Maker inkl. Blöcke & Bau (Zidinator) + Honey Farm inkl. Blöcke & Bau (Zidinator) / Frog-Light-Farm inkl. Blöcke & Bau (ChargedJakob) — 2,5 Std.

> Pause 2–3 Std. — mal an die frische Luft

@ 19:00 Beginn
Nebenaufgabe nebenbei: Wollfarm (egal wer)

> RP-Pause, weil alle Farmen fertig sind (Armor Trim holen) — 1 Std.

@ Ungefähr 20:30
Terraformen + Koordination des Stadions (beide) — 3,5 Std.
Zidinator: AFK-Eisenfarm + Chunkloader bei der Froglight-Farm

@ Ungefähr 00:00 = Tag 2 Ende!!!

## 3. / Restliche Tage

! Wecker auf 9–11:00!!!

Totems schnorren — Gabriel/Florian (egal wer)
Maze bauen + Windburst II besorgen
Farmen + Bauen den ganzen Tag — Hauptziel`;

// ---------- Vorschläge ----------
// Eine einfache Tabelle für den "💡 Vorschläge"-Tab: jeder Nutzer kann einen
// Vorschlag einreichen, der Admin nimmt an oder lehnt ab. Wird beim ersten
// Zugriff automatisch angelegt (keine manuelle D1-Migration nötig), genau
// wie bei plan_3tage/schematic_platzierung oben.
async function ensureVorschlaegeTable(env) {
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS vorschlaege (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titel TEXT,
      beschreibung TEXT,
      status TEXT,
      erstellt_von INTEGER,
      ersteller_name TEXT,
      erstellt_am TEXT
    )`
  );
}

// ---------- Benachrichtigungen ----------

async function notify(env, userId, typ, titel, text, link) {
  if (!userId) return;
  await env.DB.prepare(
    `INSERT INTO benachrichtigungen (user_id, typ, titel, text, link, gelesen, erstellt_am)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(userId, typ, titel, text || "", link || "", nowIso())
    .run();
}

async function notifyMany(env, userIds, typ, titel, text, link) {
  const uniq = [...new Set(userIds.filter(Boolean))];
  for (const uid of uniq) await notify(env, uid, typ, titel, text, link);
}

async function notifyAdmins(env, typ, titel, text, link, exceptUserId) {
  const { results } = await env.DB.prepare("SELECT id FROM users WHERE is_admin = 1").all();
  await notifyMany(env, results.map((r) => r.id).filter((id) => id !== exceptUserId), typ, titel, text, link);
}

async function addPunkte(env, userId, delta) {
  if (!userId || !delta) return;
  await env.DB.prepare("UPDATE users SET punkte = MAX(0, punkte + ?) WHERE id = ?").bind(delta, userId).run();
}

async function notifyAllActive(env, typ, titel, text, link, exceptUserId) {
  const { results } = await env.DB.prepare("SELECT id FROM users WHERE aktiv = 1 AND freigegeben = 1").all();
  await notifyMany(env, results.map((r) => r.id).filter((id) => id !== exceptUserId), typ, titel, text, link);
}

function sanitizeDateiname(name) {
  return String(name || "datei").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 180) || "datei";
}

// Prüft, ob eine vom Nutzer eingegebene Link-URL sinnvoll/sicher genug ist
// (nur http/https zulassen, damit niemand z. B. "javascript:"-Links speichert).
function sanitizeLink(raw) {
  const val = (raw || "").toString().trim();
  if (!val) return "";
  try {
    const u = new URL(val);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString().slice(0, 500);
  } catch {
    return "";
  }
}

// Prüft ein vom Nutzer eingegebenes Termin-Datum (erwartetes Format: YYYY-MM-DD,
// wie es <input type="date"> liefert). Ungültige/leere Eingaben werden zu "".
function sanitizeDatum(raw) {
  const val = (raw || "").toString().trim();
  if (!val) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : "";
}

// Prüft eine vom Nutzer eingegebene Termin-Uhrzeit (erwartetes Format: HH:MM,
// wie es <input type="time"> liefert). Ungültige/leere Eingaben werden zu "".
function sanitizeZeit(raw) {
  const val = (raw || "").toString().trim();
  if (!val) return "";
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(val) ? val : "";
}

// ---------- Router ----------

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,authorization",
      },
    });
  }

  try {
    let body = {};
    const contentType = request.headers.get("content-type") || "";
    if ((method === "POST" || method === "DELETE") && contentType.includes("application/json")) {
      try {
        body = await request.json();
      } catch {
        body = {};
      }
    }

    // ---- AUTH ----

    if (path === "/register" && method === "POST") {
      const { vorname, nachname, gamertag, passwort } = body;
      if (!vorname || !nachname || !gamertag || !passwort) return err("Bitte alle Felder ausfüllen.");
      if (passwort.length < 4) return err("Passwort muss mindestens 4 Zeichen haben.");
      const gt = gamertag.trim();
      const existing = await env.DB.prepare("SELECT id FROM users WHERE gamertag = ?").bind(gt).first();
      if (existing) return err("Dieser Gamertag ist bereits vergeben.");

      const salt = randHex(16);
      const hash = await hashPassword(passwort, salt);
      const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first();
      const isFirst = countRow.c === 0;
      const kontoId = "BB-" + String(countRow.c + 1).padStart(3, "0");
      const sklaveId = await sklaveRankId(env);

      const res = await env.DB.prepare(
        `INSERT INTO users (vorname, nachname, gamertag, password_hash, password_salt, konto_id, erstellt, aktiv, freigegeben, is_admin, rank_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
        .bind(vorname.trim(), nachname.trim(), gt, hash, salt, kontoId, nowIso(), isFirst ? 1 : 0, isFirst ? 1 : 0, sklaveId)
        .run();

      const uid = res.meta.last_row_id;

      if (isFirst) {
        const token = await makeToken(env.JWT_SECRET, { uid });
        return json({ token, konto_id: kontoId, admin: true });
      }
      return json({
        pending: true,
        message: "Konto erstellt! Ein Admin muss dich noch freischalten, bevor du dich anmelden kannst.",
      });
    }

    if (path === "/login" && method === "POST") {
      const { gamertag, passwort } = body;
      if (!gamertag || !passwort) return err("Gamertag und Passwort erforderlich.");
      const user = await env.DB.prepare("SELECT * FROM users WHERE gamertag = ?").bind(gamertag.trim()).first();
      if (!user) return err("Falsche Kombination aus Gamertag und Passwort.", 401);
      if (!user.aktiv) return err("Dieses Konto wurde deaktiviert.", 403);
      const hash = await hashPassword(passwort, user.password_salt);
      if (hash !== user.password_hash) return err("Falsche Kombination aus Gamertag und Passwort.", 401);
      if (!user.freigegeben) return err("Dein Konto wartet noch auf Freigabe durch einen Admin.", 403);

      await env.DB.prepare("UPDATE users SET letzter_login = ? WHERE id = ?").bind(nowIso(), user.id).run();
      const token = await makeToken(env.JWT_SECRET, { uid: user.id });
      return json({ token });
    }

    if (path === "/me" && method === "GET") {
      const user = await requireUser(request, env);
      if (!user) return err("Nicht angemeldet.", 401);
      const gesamt = await totalHoursFor(env, user.gamertag);
      const heute = await todayHoursFor(env, user.gamertag);
      const open = await openSessionFor(env, user.gamertag);
      const unreadRow = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM benachrichtigungen WHERE user_id = ? AND gelesen = 0"
      ).bind(user.id).first();
      return json({
        id: user.id,
        vorname: user.vorname,
        nachname: user.nachname,
        gamertag: user.gamertag,
        konto_id: user.konto_id,
        is_admin: !!user.is_admin,
        rang: user.rank ? { id: user.rank.id, name: user.rank.name, level: user.rank.level, farbe: user.rank.farbe } : null,
        kann_aufgaben_zuweisen: hasPerm(user, user.rank, "kann_aufgaben_zuweisen"),
        kann_statistiken_sehen: hasPerm(user, user.rank, "kann_statistiken_sehen"),
        kann_kalender_erstellen: hasPerm(user, user.rank, "kann_kalender_erstellen"),
        gesamt_std: gesamt,
        heute_std: heute,
        online: !!open,
        online_seit: open ? open.start : null,
        badge: badgeFor(gesamt),
        punkte: user.punkte || 0,
        avatar: avatarFor(user),
        unread_notifications: unreadRow.c || 0,
      });
    }

    // Ab hier: Login erforderlich
    const user = await requireUser(request, env);
    if (!user) return err("Nicht angemeldet.", 401);
    const canAssign = hasPerm(user, user.rank, "kann_aufgaben_zuweisen");
    const canSeeStats = hasPerm(user, user.rank, "kann_statistiken_sehen");
    const canKalender = hasPerm(user, user.rank, "kann_kalender_erstellen");
    const meName = `${user.vorname} ${user.nachname}`;

    // ---- EIGENES PROFIL / AVATAR ----

    if (path === "/me/avatar" && method === "POST") {
      const { avatar } = body;
      const val = (avatar || "").trim().slice(0, 8);
      await env.DB.prepare("UPDATE users SET avatar = ? WHERE id = ?").bind(val || null, user.id).run();
      return json({ ok: true });
    }

    // ---- SCHEMATIC-PLATZIERUNG ----
    // GET ist für alle angemeldeten Nutzer offen (nur Anzeige), POST nur für Admins.

    if (path === "/schematic" && method === "GET") {
      await ensureSchematicTable(env);
      const row = await env.DB.prepare("SELECT x, y, z FROM schematic_platzierung WHERE id = 1").first();
      return json(row || { x: null, y: null, z: null });
    }

    if (path === "/schematic" && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      await ensureSchematicTable(env);
      const x = parseCoordValue(body.x);
      const y = parseCoordValue(body.y);
      const z = parseCoordValue(body.z);
      await env.DB.prepare(
        `INSERT INTO schematic_platzierung (id, x, y, z) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET x = excluded.x, y = excluded.y, z = excluded.z`
      )
        .bind(x, y, z)
        .run();
      return json({ ok: true, x, y, z });
    }

    // ---- 3-TAGE-PLAN (editierbarer Text) ----
    // GET ist für alle angemeldeten Nutzer offen (nur Anzeige), POST nur für Admins.

    if (path === "/plan3tage" && method === "GET") {
      await ensurePlanTable(env);
      const row = await env.DB.prepare("SELECT text, aktualisiert_am, aktualisiert_von FROM plan_3tage WHERE id = 1").first();
      return json({
        text: row && row.text ? row.text : DEFAULT_PLAN_3TAGE,
        aktualisiert_am: row ? row.aktualisiert_am : null,
        aktualisiert_von: row ? row.aktualisiert_von : null,
      });
    }

    if (path === "/plan3tage" && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      await ensurePlanTable(env);
      const text = (body.text || "").toString().slice(0, 20000);
      await env.DB.prepare(
        `INSERT INTO plan_3tage (id, text, aktualisiert_am, aktualisiert_von) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET text = excluded.text, aktualisiert_am = excluded.aktualisiert_am, aktualisiert_von = excluded.aktualisiert_von`
      )
        .bind(text, nowIso(), meName)
        .run();
      return json({ ok: true });
    }

    // ---- ONLINE-ZEIT ----

    if (path === "/session/toggle" && method === "POST") {
      const open = await env.DB.prepare(
        "SELECT * FROM sessions WHERE user_id = ? AND status = 'ON' ORDER BY id DESC LIMIT 1"
      ).bind(user.id).first();

      if (open) {
        const startMs = new Date(open.start).getTime();
        const ende = new Date();
        const endeMs = ende.getTime();

        let dauer = 0;
        if (Number.isFinite(startMs) && startMs <= endeMs) {
          dauer = (endeMs - startMs) / 1000 / 3600;
        }

        await env.DB.prepare(
          `UPDATE sessions
           SET ende = ?, dauer_std = ?, status = 'OFF'
           WHERE id = ? AND user_id = ? AND status = 'ON'`
        ).bind(ende.toISOString(), dauer, open.id, user.id).run();

        const stale = await env.DB.prepare(
          "SELECT id, start FROM sessions WHERE user_id = ? AND status = 'ON' ORDER BY id ASC"
        ).bind(user.id).all();

        for (const s of stale.results || []) {
          const staleStart = new Date(s.start).getTime();
          let staleDauer = 0;
          if (Number.isFinite(staleStart) && staleStart <= endeMs) {
            staleDauer = (endeMs - staleStart) / 1000 / 3600;
          }

          await env.DB.prepare(
            `UPDATE sessions
             SET ende = ?, dauer_std = ?, status = 'OFF'
             WHERE id = ? AND user_id = ? AND status = 'ON'`
          ).bind(ende.toISOString(), staleDauer, s.id, user.id).run();
        }

        const gesamt = await totalHoursFor(env, user.gamertag);
        const heute = await todayHoursFor(env, user.gamertag);

        return json({ online: false, seit: null, dauer_std: dauer, gesamt_std: gesamt, heute_std: heute });
      }

      const startIso = nowIso();
      const code = "S-" + randHex(4).toUpperCase();

      await env.DB.prepare(
        `INSERT INTO sessions
          (user_id, gamertag, datum, start, status, quelle, session_code)
         VALUES (?, ?, ?, ?, 'ON', 'WEB', ?)`
      ).bind(user.id, user.gamertag, todayStr(), startIso, code).run();

      return json({ online: true, seit: startIso, dauer_std: 0 });
    }

    if (path === "/session/status" && method === "GET") {
      const open = await env.DB.prepare(
        "SELECT * FROM sessions WHERE user_id = ? AND status = 'ON' ORDER BY id DESC LIMIT 1"
      ).bind(user.id).first();

      const gesamt = await totalHoursFor(env, user.gamertag);
      const heute = await todayHoursFor(env, user.gamertag);

      return json({ online: !!open, seit: open ? open.start : null, gesamt_std: gesamt, heute_std: heute });
    }

    // ---- SPIELER-LISTE (für Zuweisungs-Auswahl) ----

    if (path === "/users/active" && method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, vorname, nachname, gamertag, avatar, punkte FROM users WHERE aktiv = 1 AND freigegeben = 1 ORDER BY vorname"
      ).all();
      return json({ users: results.map((u) => ({ ...u, avatar: avatarFor(u) })) });
    }

    // ---- BLOCKLISTEN AUS DEM LITEMATICA-BAUPLAN ----
    // Statische Daten aus block-layers-data.js (kein D1 nötig). Jeder Eintrag:
    // { nr, y, total, blocks: [{ id, label, count }, ...] }

    if (path === "/block-layers" && method === "GET") {
      return json({ layers: BLOCK_LAYERS });
    }

    // ---- RÄNGE ----

    if (path === "/ranks" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM ranks ORDER BY level DESC").all();
      return json({ ranks: results });
    }

    if (path === "/ranks" && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const { name, level, kann_aufgaben_zuweisen, kann_statistiken_sehen, kann_kalender_erstellen, farbe } = body;
      if (!name || !name.trim()) return err("Rangname fehlt.");
      if (name.trim().toLowerCase() === "sklave") return err('Der Rang "Sklave" existiert bereits als niedrigster Rang.');
      const existing = await env.DB.prepare("SELECT id FROM ranks WHERE name = ?").bind(name.trim()).first();
      if (existing) return err("Dieser Rang existiert bereits.");
      const res = await env.DB.prepare(
        `INSERT INTO ranks (name, level, kann_aufgaben_zuweisen, kann_statistiken_sehen, kann_kalender_erstellen, farbe) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          name.trim(),
          Math.max(1, parseInt(level) || 1),
          kann_aufgaben_zuweisen ? 1 : 0,
          kann_statistiken_sehen ? 1 : 0,
          kann_kalender_erstellen ? 1 : 0,
          farbe || "#f2c744"
        )
        .run();
      return json({ id: res.meta.last_row_id });
    }

    const rankUpdateMatch = path.match(/^\/ranks\/(\d+)$/);
    if (rankUpdateMatch && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const id = rankUpdateMatch[1];
      const rank = await env.DB.prepare("SELECT * FROM ranks WHERE id = ?").bind(id).first();
      if (!rank) return err("Rang nicht gefunden.", 404);
      const { level, kann_aufgaben_zuweisen, kann_statistiken_sehen, kann_kalender_erstellen, farbe } = body;
      const isSklave = rank.name === "Sklave";
      await env.DB.prepare(
        `UPDATE ranks SET level = ?, kann_aufgaben_zuweisen = ?, kann_statistiken_sehen = ?, kann_kalender_erstellen = ?, farbe = ? WHERE id = ?`
      )
        .bind(
          isSklave ? 0 : Math.max(1, parseInt(level) || rank.level),
          kann_aufgaben_zuweisen ? 1 : 0,
          kann_statistiken_sehen ? 1 : 0,
          kann_kalender_erstellen ? 1 : 0,
          farbe || rank.farbe,
          id
        )
        .run();
      return json({ ok: true });
    }

    const rankDeleteMatch = path.match(/^\/ranks\/(\d+)$/);
    if (rankDeleteMatch && method === "DELETE") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const id = rankDeleteMatch[1];
      const rank = await env.DB.prepare("SELECT * FROM ranks WHERE id = ?").bind(id).first();
      if (!rank) return err("Rang nicht gefunden.", 404);
      if (rank.name === "Sklave") return err('Der Rang "Sklave" kann nicht gelöscht werden.');
      const inUse = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE rank_id = ?").bind(id).first();
      if (inUse.c > 0) return err("Diesem Rang sind noch Spieler zugeordnet — erst umverteilen.");
      await env.DB.prepare("DELETE FROM ranks WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    // ---- AUFGABEN ----

    if (path === "/tasks" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM tasks ORDER BY id DESC LIMIT 200").all();
      return json({ tasks: await attachTaskAssignees(env, results) });
    }

    if (path === "/tasks" && method === "POST") {
      const { titel, prioritaet, zustaendig_user_id, zustaendig_user_ids, punkte, link } = body;
      if (!titel || !titel.trim()) return err("Aufgabentitel fehlt.");

      let ids = Array.isArray(zustaendig_user_ids) ? zustaendig_user_ids.map((x) => Number(x)).filter(Boolean) : [];
      if (!ids.length && zustaendig_user_id) ids = [Number(zustaendig_user_id)];

      let zId = null;
      let zName = null;
      let zugewiesenVon = null;
      let assignedTargets = [];
      if (ids.length) {
        if (!canAssign) return err("Keine Berechtigung, Aufgaben zuzuweisen.", 403);
        for (const uid of ids) {
          const target = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND aktiv = 1 AND freigegeben = 1").bind(uid).first();
          if (!target) return err("Spieler nicht gefunden.", 404);
          assignedTargets.push(target);
        }
        zId = assignedTargets[0].id;
        zName = assignedTargets.length > 1
          ? assignedTargets.map((t) => `${t.vorname} ${t.nachname}`).join(" / ")
          : `${assignedTargets[0].vorname} ${assignedTargets[0].nachname}`;
        zugewiesenVon = user.id;
      }

      const pkt = user.is_admin ? Math.max(0, parseInt(punkte) || 0) : 0;
      const erwSek = Math.max(0, parseInt(body.erwartete_minuten) || 0) * 60;
      const linkWert = sanitizeLink(link);
      const datumWert = sanitizeDatum(body.datum);
      const zeitWert = sanitizeZeit(body.zeit);
      // Erwartete Zeit, Zuweisungs-IDs, Link UND geplanter Termin direkt in einem
      // Schritt ins "notiz"-Feld packen.
      const notizWert = packMeta("", { erw: erwSek, verb: 0, ids: assignedTargets.map((t) => t.id), link: linkWert, datum: datumWert, zeit: zeitWert });

      const res = await env.DB.prepare(
        `INSERT INTO tasks (titel, zustaendig_user_id, zustaendig_name, zugewiesen_von, status, prioritaet, notiz, erstellt_am, erstellt_von, punkte)
         VALUES (?, ?, ?, ?, 'OFFEN', ?, ?, ?, ?, ?)`
      )
        .bind(titel.trim(), zId, zName, zugewiesenVon, prioritaet || "NORMAL", notizWert, nowIso(), user.id, pkt)
        .run();

      const newId = res.meta.last_row_id;
      if (ids.length) {
        await notifyMany(
          env,
          assignedTargets.map((t) => t.id),
          "AUFGABE_ZUGEWIESEN",
          "Neue Aufgabe zugewiesen",
          `${meName} hat dir „${titel.trim()}" zugewiesen.`,
          "aufgaben"
        );
      }
      return json({ id: newId });
    }

    // Admin/Berechtigte können eine Aufgabe JEDERZEIT neu zuweisen — auch wenn
    // bereits jemand zugewiesen ist oder sie freiwillig angenommen wurde. Die
    // erwartete/verbrauchte Zeit, der Link UND der geplante Termin im Meta-Feld
    // bleiben dabei unangetastet erhalten.
    const taskAssignMatch = path.match(/^\/tasks\/(\d+)\/zuweisen$/);
    if (taskAssignMatch && method === "POST") {
      if (!canAssign) return err("Keine Berechtigung.", 403);
      const id = taskAssignMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      const { user_id, user_ids } = body;
      let ids = Array.isArray(user_ids) ? user_ids.map((x) => Number(x)).filter(Boolean) : [];
      if (!ids.length && user_id) ids = [Number(user_id)];
      let zId = null, zName = null;
      let assignedTargets = [];
      if (ids.length) {
        for (const uid of ids) {
          const target = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND aktiv = 1 AND freigegeben = 1").bind(uid).first();
          if (!target) return err("Spieler nicht gefunden.", 404);
          assignedTargets.push(target);
        }
        zId = assignedTargets[0].id;
        zName = assignedTargets.length > 1
          ? assignedTargets.map((t) => `${t.vorname} ${t.nachname}`).join(" / ")
          : `${assignedTargets[0].vorname} ${assignedTargets[0].nachname}`;
      }
      await env.DB.prepare("UPDATE tasks SET zustaendig_user_id = ?, zustaendig_name = ?, zugewiesen_von = ? WHERE id = ?")
        .bind(zId, zName, user.id, id).run();
      await setTaskAssignees(env, id, assignedTargets.map((t) => t.id));
      if (assignedTargets.length) {
        await notifyMany(
          env,
          assignedTargets.map((t) => t.id),
          "AUFGABE_ZUGEWIESEN",
          "Aufgabe neu zugewiesen",
          `${meName} hat dir die Aufgabe „${task.titel}" zugewiesen.`,
          "aufgaben"
        );
      }
      return json({ ok: true });
    }

    // Admin/Berechtigte können den Link einer Aufgabe nachträglich ändern/entfernen.
    const taskLinkMatch = path.match(/^\/tasks\/(\d+)\/link$/);
    if (taskLinkMatch && method === "POST") {
      if (!canAssign) return err("Keine Berechtigung.", 403);
      const id = taskLinkMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      const linkWert = sanitizeLink(body.link);
      await setTaskMeta(env, id, { link: linkWert });
      return json({ ok: true, link: linkWert });
    }

    // Admin/Berechtigte können den geplanten Termin (Datum + Uhrzeit) einer
    // Aufgabe nachträglich ändern/entfernen — z. B. direkt aus dem Zeitstrahl heraus.
    const taskTerminMatch = path.match(/^\/tasks\/(\d+)\/termin$/);
    if (taskTerminMatch && method === "POST") {
      if (!canAssign) return err("Keine Berechtigung.", 403);
      const id = taskTerminMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      const datumWert = sanitizeDatum(body.datum);
      const zeitWert = sanitizeZeit(body.zeit);
      await setTaskMeta(env, id, { datum: datumWert, zeit: zeitWert });
      return json({ ok: true, datum: datumWert, zeit: zeitWert });
    }

    const taskAcceptMatch = path.match(/^\/tasks\/(\d+)\/annehmen$/);
    if (taskAcceptMatch && method === "POST") {
      const id = taskAcceptMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      if (task.status !== "OFFEN") return err("Nur offene Aufgaben können angenommen werden.");
      if (await isAssignedToTask(env, task, user.id)) return err("Du bist dieser Aufgabe bereits zugewiesen.");

      const currentIds = await taskAssigneeIds(env, id);
      const newIds = [...currentIds, user.id];
      await setTaskAssignees(env, id, newIds);
      const alleZugewiesenen = await getTaskAssignees(env, id);
      const zName = alleZugewiesenen.map((a) => `${a.vorname} ${a.nachname}`).join(" / ");
      await env.DB.prepare("UPDATE tasks SET zustaendig_user_id = ?, zustaendig_name = ? WHERE id = ?")
        .bind(task.zustaendig_user_id || user.id, zName, id)
        .run();

      await notifyMany(
        env,
        [...currentIds, task.zugewiesen_von, task.erstellt_von].filter((x) => x && x !== user.id),
        "AUFGABE_ZUGEWIESEN",
        "Aufgabe angenommen",
        `${meName} hat sich die offene Aufgabe „${task.titel}" freiwillig geschnappt.`,
        "aufgaben"
      );
      return json({ ok: true });
    }

    const taskStartMatch = path.match(/^\/tasks\/(\d+)\/start$/);
    if (taskStartMatch && method === "POST") {
      const id = taskStartMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      if (task.status !== "OFFEN") return err("Aufgabe kann nicht gestartet werden.");
      const hatZuweisung = task.zustaendig_user_id || (await taskAssigneeIds(env, id)).length > 0;
      if (hatZuweisung && !(await isAssignedToTask(env, task, user.id)) && !canAssign) {
        return err("Diese Aufgabe ist bereits jemand anderem zugewiesen.", 403);
      }
      await env.DB.prepare(
        "UPDATE tasks SET status = 'LAEUFT', start_zeit = ?, zustaendig_user_id = ?, zustaendig_name = ? WHERE id = ?"
      )
        .bind(nowIso(), task.zustaendig_user_id || user.id, task.zustaendig_name || meName, id)
        .run();
      if (!hatZuweisung) await setTaskAssignees(env, id, [user.id]);
      return json({ ok: true });
    }

    const taskPauseMatch = path.match(/^\/tasks\/(\d+)\/pause$/);
    if (taskPauseMatch && method === "POST") {
      const id = taskPauseMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      if (task.status !== "LAEUFT") return err("Nur laufende Aufgaben können pausiert werden.");
      if (!(await isAssignedToTask(env, task, user.id)) && !canAssign) return err("Keine Berechtigung.", 403);
      const { verb } = unpackMeta(task.notiz);
      const zusatz = task.start_zeit ? Math.max(0, (Date.now() - new Date(task.start_zeit).getTime()) / 1000) : 0;
      const neuerVerb = Math.round(verb + zusatz);
      await setTaskMeta(env, id, { verb: neuerVerb });
      await env.DB.prepare("UPDATE tasks SET status = 'PAUSIERT' WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    const taskResumeMatch = path.match(/^\/tasks\/(\d+)\/resume$/);
    if (taskResumeMatch && method === "POST") {
      const id = taskResumeMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      if (task.status !== "PAUSIERT") return err("Nur pausierte Aufgaben können fortgesetzt werden.");
      if (!(await isAssignedToTask(env, task, user.id)) && !canAssign) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("UPDATE tasks SET status = 'LAEUFT', start_zeit = ? WHERE id = ?")
        .bind(nowIso(), id)
        .run();
      return json({ ok: true });
    }

    const taskCompleteMatch = path.match(/^\/tasks\/(\d+)\/complete$/);
    if (taskCompleteMatch && method === "POST") {
      const id = taskCompleteMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      if (!(await isAssignedToTask(env, task, user.id)) && !canAssign) return err("Keine Berechtigung.", 403);
      const { verb } = unpackMeta(task.notiz);
      let verbrauchte = verb;
      if (task.status === "LAEUFT" && task.start_zeit) {
        verbrauchte += Math.max(0, (Date.now() - new Date(task.start_zeit).getTime()) / 1000);
      }
      await setTaskMeta(env, id, { verb: Math.round(verbrauchte) });
      await env.DB.prepare("UPDATE tasks SET status = 'ERLEDIGT', end_zeit = ? WHERE id = ?")
        .bind(nowIso(), id)
        .run();
      const assignees = await getTaskAssignees(env, id);
      const empfaenger = task.zustaendig_user_id || user.id;
      await verteilePunkte(env, task.punkte, assignees, empfaenger);
      await notifyMany(
        env,
        [task.zugewiesen_von, task.erstellt_von].filter((x) => x && x !== user.id),
        "AUFGABE_ERLEDIGT",
        "Aufgabe erledigt",
        `${meName} hat „${task.titel}" erledigt.${task.punkte ? ` (+${task.punkte} Punkte)` : ""}`,
        "aufgaben"
      );
      return json({ ok: true });
    }

    const taskDeleteMatch = path.match(/^\/tasks\/(\d+)$/);
    if (taskDeleteMatch && method === "DELETE") {
      const id = taskDeleteMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      if (!user.is_admin && task.erstellt_von !== user.id) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    // ---- PUNKTE-SHOP ----

    if (path === "/shop/items" && method === "GET") {
      const q = user.is_admin
        ? "SELECT * FROM shop_items ORDER BY aktiv DESC, id DESC"
        : "SELECT * FROM shop_items WHERE aktiv = 1 ORDER BY kosten ASC";
      const { results } = await env.DB.prepare(q).all();
      return json({ items: results });
    }

    if (path === "/shop/items" && method === "POST") {
      if (!user.is_admin) return err("Nur der Admin kann Angebote erstellen.", 403);
      const { titel, beschreibung, kosten } = body;
      if (!titel || !titel.trim()) return err("Titel fehlt.");
      const k = parseInt(kosten);
      if (!k || k <= 0) return err("Bitte gültige Punktekosten angeben.");
      const res = await env.DB.prepare(
        `INSERT INTO shop_items (titel, beschreibung, kosten, aktiv, erstellt_von, erstellt_am) VALUES (?, ?, ?, 1, ?, ?)`
      )
        .bind(titel.trim(), (beschreibung || "").trim(), k, user.id, nowIso())
        .run();
      return json({ id: res.meta.last_row_id });
    }

    const shopToggleMatch = path.match(/^\/shop\/items\/(\d+)\/toggle$/);
    if (shopToggleMatch && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const id = shopToggleMatch[1];
      const item = await env.DB.prepare("SELECT * FROM shop_items WHERE id = ?").bind(id).first();
      if (!item) return err("Angebot nicht gefunden.", 404);
      await env.DB.prepare("UPDATE shop_items SET aktiv = ? WHERE id = ?").bind(item.aktiv ? 0 : 1, id).run();
      return json({ ok: true });
    }

    const shopDeleteMatch = path.match(/^\/shop\/items\/(\d+)$/);
    if (shopDeleteMatch && method === "DELETE") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      await env.DB.prepare("DELETE FROM shop_items WHERE id = ?").bind(shopDeleteMatch[1]).run();
      return json({ ok: true });
    }

    const shopBuyMatch = path.match(/^\/shop\/items\/(\d+)\/kaufen$/);
    if (shopBuyMatch && method === "POST") {
      const id = shopBuyMatch[1];
      const item = await env.DB.prepare("SELECT * FROM shop_items WHERE id = ? AND aktiv = 1").bind(id).first();
      if (!item) return err("Angebot nicht gefunden oder nicht mehr verfügbar.", 404);
      if ((user.punkte || 0) < item.kosten) return err("Nicht genug Punkte für dieses Angebot.");
      await addPunkte(env, user.id, -item.kosten);
      const res = await env.DB.prepare(
        `INSERT INTO shop_kaeufe (item_id, item_titel, kosten, user_id, user_name, status, erstellt_am)
         VALUES (?, ?, ?, ?, ?, 'OFFEN', ?)`
      )
        .bind(item.id, item.titel, item.kosten, user.id, meName, nowIso())
        .run();
      await notifyAdmins(
        env,
        "SHOP_KAUF",
        "Neue Bestellung im Punkte-Shop",
        `${meName} hat „${item.titel}" für ${item.kosten} Punkte gekauft.`,
        "shop",
        user.id
      );
      return json({ id: res.meta.last_row_id });
    }

    if (path === "/shop/kaeufe" && method === "GET") {
      const q = user.is_admin
        ? "SELECT * FROM shop_kaeufe ORDER BY status ASC, id DESC LIMIT 300"
        : "SELECT * FROM shop_kaeufe WHERE user_id = ? ORDER BY id DESC LIMIT 100";
      const stmt = user.is_admin ? env.DB.prepare(q) : env.DB.prepare(q).bind(user.id);
      const { results } = await stmt.all();
      return json({ kaeufe: results });
    }

    const shopFulfilMatch = path.match(/^\/shop\/kaeufe\/(\d+)\/erledigt$/);
    if (shopFulfilMatch && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const id = shopFulfilMatch[1];
      const kauf = await env.DB.prepare("SELECT * FROM shop_kaeufe WHERE id = ?").bind(id).first();
      if (!kauf) return err("Bestellung nicht gefunden.", 404);
      await env.DB.prepare("UPDATE shop_kaeufe SET status = 'ABGESCHLOSSEN' WHERE id = ?").bind(id).run();
      await notify(env, kauf.user_id, "SHOP_ERLEDIGT", "Bestellung ausgeliefert", `Deine Bestellung „${kauf.item_titel}" wurde vom Admin freigegeben.`, "shop");
      return json({ ok: true });
    }

    // ---- STADION-BAU (Block-Layer) ----

    if (path === "/stadion/layers" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM stadium_layers ORDER BY layer_nr ASC").all();
      return json({ layers: await attachLayerAssignees(env, results) });
    }

    if (path === "/stadion/layers" && method === "POST") {
      if (!canAssign) return err("Keine Berechtigung, Stadion-Layer anzulegen.", 403);
      const { name, punkte, zustaendig_user_id, zustaendig_user_ids, blocklayer_nr } = body;
      if (!name || !name.trim()) return err("Name der Layer fehlt.");
      const maxRow = await env.DB.prepare("SELECT COALESCE(MAX(layer_nr),0) AS m FROM stadium_layers").first();
      const nr = (maxRow.m || 0) + 1;

      let ids = Array.isArray(zustaendig_user_ids) ? zustaendig_user_ids.map((x) => Number(x)).filter(Boolean) : [];
      if (!ids.length && zustaendig_user_id) ids = [Number(zustaendig_user_id)];

      let zId = null, zName = null, zugewiesenVon = null;
      let assignedTargets = [];
      if (ids.length) {
        for (const uid of ids) {
          const target = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND aktiv = 1 AND freigegeben = 1").bind(uid).first();
          if (!target) return err("Spieler nicht gefunden.", 404);
          assignedTargets.push(target);
        }
        zId = assignedTargets[0].id;
        zName = assignedTargets.length > 1
          ? assignedTargets.map((t) => `${t.vorname} ${t.nachname}`).join(" / ")
          : `${assignedTargets[0].vorname} ${assignedTargets[0].nachname}`;
        zugewiesenVon = user.id;
      }
      const pkt = user.is_admin ? Math.max(0, parseInt(punkte) || 0) : 0;
      const erwSek = Math.max(0, parseInt(body.erwartete_minuten) || 0) * 60;
      const datumWert = sanitizeDatum(body.datum);
      const zeitWert = sanitizeZeit(body.zeit);
      // Gültigkeit der Block-Layer-Nummer prüfen (muss in BLOCK_LAYERS existieren).
      const blkWunsch = Math.max(0, parseInt(blocklayer_nr) || 0);
      const blk = blkWunsch && BLOCK_LAYERS.some((bl) => bl.nr === blkWunsch) ? blkWunsch : 0;
      // Erwartete Zeit, Zuweisungs-IDs, Block-Layer-Verknüpfung UND geplanter
      // Termin direkt in einem Schritt hinter den Layer-Namen packen.
      const nameWert = packMeta(name.trim(), { erw: erwSek, verb: 0, ids: assignedTargets.map((t) => t.id), blk, datum: datumWert, zeit: zeitWert });

      const res = await env.DB.prepare(
        `INSERT INTO stadium_layers (layer_nr, name, status, zustaendig_user_id, zustaendig_name, zugewiesen_von, punkte, erstellt_am, erstellt_von)
         VALUES (?, ?, 'OFFEN', ?, ?, ?, ?, ?, ?)`
      )
        .bind(nr, nameWert, zId, zName, zugewiesenVon, pkt, nowIso(), user.id)
        .run();

      const newId = res.meta.last_row_id;
      if (ids.length) {
        await notifyMany(
          env,
          assignedTargets.map((t) => t.id),
          "LAYER_ZUGEWIESEN",
          "Stadion-Layer zugewiesen",
          `${meName} hat dir die Layer „${name.trim()}" zugewiesen.`,
          "stadion"
        );
      }
      return json({ id: newId, layer_nr: nr });
    }

    // Admin/Berechtigte können eine Layer JEDERZEIT neu zuweisen — auch wenn
    // bereits jemand zugewiesen ist. Erwartete/verbrauchte Zeit, die
    // Block-Layer-Verknüpfung UND der geplante Termin bleiben erhalten.
    const layerAssignMatch = path.match(/^\/stadion\/layers\/(\d+)\/zuweisen$/);
    if (layerAssignMatch && method === "POST") {
      if (!canAssign) return err("Keine Berechtigung.", 403);
      const id = layerAssignMatch[1];
      const layer = await env.DB.prepare("SELECT * FROM stadium_layers WHERE id = ?").bind(id).first();
      if (!layer) return err("Layer nicht gefunden.", 404);
      const { base: layerBaseName } = unpackMeta(layer.name);
      const { user_id, user_ids } = body;
      let ids = Array.isArray(user_ids) ? user_ids.map((x) => Number(x)).filter(Boolean) : [];
      if (!ids.length && user_id) ids = [Number(user_id)];
      let zId = null, zName = null;
      let assignedTargets = [];
      if (ids.length) {
        for (const uid of ids) {
          const target = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND aktiv = 1 AND freigegeben = 1").bind(uid).first();
          if (!target) return err("Spieler nicht gefunden.", 404);
          assignedTargets.push(target);
        }
        zId = assignedTargets[0].id;
        zName = assignedTargets.length > 1
          ? assignedTargets.map((t) => `${t.vorname} ${t.nachname}`).join(" / ")
          : `${assignedTargets[0].vorname} ${assignedTargets[0].nachname}`;
      }
      await env.DB.prepare("UPDATE stadium_layers SET zustaendig_user_id = ?, zustaendig_name = ?, zugewiesen_von = ? WHERE id = ?")
        .bind(zId, zName, user.id, id).run();
      await setLayerAssignees(env, id, assignedTargets.map((t) => t.id));
      if (assignedTargets.length) {
        await notifyMany(env, assignedTargets.map((t) => t.id), "LAYER_ZUGEWIESEN", "Stadion-Layer zugewiesen", `${meName} hat dir die Layer „${layerBaseName}" zugewiesen.`, "stadion");
      }
      return json({ ok: true });
    }

    // Admin/Berechtigte können die verknüpfte Litematica-Blockliste einer
    // bestehenden Layer jederzeit ändern oder entfernen (blocklayer_nr = 0).
    const layerBlockLinkMatch = path.match(/^\/stadion\/layers\/(\d+)\/blockliste$/);
    if (layerBlockLinkMatch && method === "POST") {
      if (!canAssign) return err("Keine Berechtigung.", 403);
      const id = layerBlockLinkMatch[1];
      const layer = await env.DB.prepare("SELECT * FROM stadium_layers WHERE id = ?").bind(id).first();
      if (!layer) return err("Layer nicht gefunden.", 404);
      const blkWunsch = Math.max(0, parseInt(body.blocklayer_nr) || 0);
      const blk = blkWunsch && BLOCK_LAYERS.some((bl) => bl.nr === blkWunsch) ? blkWunsch : 0;
      await setLayerMeta(env, id, { blk });
      return json({ ok: true, blocklayer_nr: blk });
    }

    // Admin/Berechtigte können den geplanten Termin (Datum + Uhrzeit) einer
    // Stadion-Layer nachträglich ändern/entfernen — z. B. direkt aus dem Zeitstrahl heraus.
    const layerTerminMatch = path.match(/^\/stadion\/layers\/(\d+)\/termin$/);
    if (layerTerminMatch && method === "POST") {
      if (!canAssign) return err("Keine Berechtigung.", 403);
      const id = layerTerminMatch[1];
      const layer = await env.DB.prepare("SELECT * FROM stadium_layers WHERE id = ?").bind(id).first();
      if (!layer) return err("Layer nicht gefunden.", 404);
      const datumWert = sanitizeDatum(body.datum);
      const zeitWert = sanitizeZeit(body.zeit);
      await setLayerMeta(env, id, { datum: datumWert, zeit: zeitWert });
      return json({ ok: true, datum: datumWert, zeit: zeitWert });
    }

    const layerStartMatch = path.match(/^\/stadion\/layers\/(\d+)\/start$/);
    if (layerStartMatch && method === "POST") {
      const id = layerStartMatch[1];
      const layer = await env.DB.prepare("SELECT * FROM stadium_layers WHERE id = ?").bind(id).first();
      if (!layer) return err("Layer nicht gefunden.", 404);
      if (layer.status !== "OFFEN") return err("Layer kann nicht gestartet werden.");
      const hatZuweisung = layer.zustaendig_user_id || (await layerAssigneeIds(env, id)).length > 0;
      if (hatZuweisung && !(await isAssignedToLayer(env, layer, user.id)) && !canAssign) return err("Diese Layer ist bereits jemand anderem zugewiesen.", 403);
      await env.DB.prepare("UPDATE stadium_layers SET status = 'LAEUFT', start_zeit = ?, zustaendig_user_id = ?, zustaendig_name = ? WHERE id = ?")
        .bind(nowIso(), layer.zustaendig_user_id || user.id, layer.zustaendig_name || meName, id).run();
      if (!hatZuweisung) await setLayerAssignees(env, id, [user.id]);
      return json({ ok: true });
    }

    const layerPauseMatch = path.match(/^\/stadion\/layers\/(\d+)\/pause$/);
    if (layerPauseMatch && method === "POST") {
      const id = layerPauseMatch[1];
      const layer = await env.DB.prepare("SELECT * FROM stadium_layers WHERE id = ?").bind(id).first();
      if (!layer) return err("Layer nicht gefunden.", 404);
      if (layer.status !== "LAEUFT") return err("Nur laufende Layer können pausiert werden.");
      if (!(await isAssignedToLayer(env, layer, user.id)) && !canAssign) return err("Keine Berechtigung.", 403);
      const { verb } = unpackMeta(layer.name);
      const zusatz = layer.start_zeit ? Math.max(0, (Date.now() - new Date(layer.start_zeit).getTime()) / 1000) : 0;
      const neuerVerb = Math.round(verb + zusatz);
      await setLayerMeta(env, id, { verb: neuerVerb });
      await env.DB.prepare("UPDATE stadium_layers SET status = 'PAUSIERT' WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    const layerResumeMatch = path.match(/^\/stadion\/layers\/(\d+)\/resume$/);
    if (layerResumeMatch && method === "POST") {
      const id = layerResumeMatch[1];
      const layer = await env.DB.prepare("SELECT * FROM stadium_layers WHERE id = ?").bind(id).first();
      if (!layer) return err("Layer nicht gefunden.", 404);
      if (layer.status !== "PAUSIERT") return err("Nur pausierte Layer können fortgesetzt werden.");
      if (!(await isAssignedToLayer(env, layer, user.id)) && !canAssign) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("UPDATE stadium_layers SET status = 'LAEUFT', start_zeit = ? WHERE id = ?").bind(nowIso(), id).run();
      return json({ ok: true });
    }

    const layerCompleteMatch = path.match(/^\/stadion\/layers\/(\d+)\/complete$/);
    if (layerCompleteMatch && method === "POST") {
      const id = layerCompleteMatch[1];
      const layer = await env.DB.prepare("SELECT * FROM stadium_layers WHERE id = ?").bind(id).first();
      if (!layer) return err("Layer nicht gefunden.", 404);
      if (!(await isAssignedToLayer(env, layer, user.id)) && !canAssign) return err("Keine Berechtigung.", 403);
      const { base, verb } = unpackMeta(layer.name);
      let verbrauchte = verb;
      if (layer.status === "LAEUFT" && layer.start_zeit) {
        verbrauchte += Math.max(0, (Date.now() - new Date(layer.start_zeit).getTime()) / 1000);
      }
      await setLayerMeta(env, id, { verb: Math.round(verbrauchte) });
      await env.DB.prepare("UPDATE stadium_layers SET status = 'FERTIG', end_zeit = ? WHERE id = ?").bind(nowIso(), id).run();
      const assignees = await getLayerAssignees(env, id);
      const empfaenger = layer.zustaendig_user_id || user.id;
      await verteilePunkte(env, layer.punkte, assignees, empfaenger);
      await notifyMany(
        env,
        [layer.zugewiesen_von].filter((x) => x && x !== user.id),
        "LAYER_FERTIG",
        "Stadion-Layer fertiggestellt",
        `${meName} hat die Layer „${base}" fertiggestellt. Das Stadion wächst! 🏟️`,
        "stadion"
      );
      return json({ ok: true });
    }

    const layerDeleteMatch = path.match(/^\/stadion\/layers\/(\d+)$/);
    if (layerDeleteMatch && method === "DELETE") {
      if (!user.is_admin && !canAssign) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("DELETE FROM stadium_layers WHERE id = ?").bind(layerDeleteMatch[1]).run();
      return json({ ok: true });
    }

    // ---- BAU-GRUPPEN ----

    if (path === "/gruppen" && method === "GET") {
      const { results: gruppen } = await env.DB.prepare("SELECT * FROM bau_gruppen ORDER BY name ASC").all();
      const out = [];
      for (const g of gruppen) {
        const { results: mitglieder } = await env.DB.prepare(
          `SELECT u.id, u.vorname, u.nachname, u.gamertag, u.avatar FROM bau_gruppen_mitglieder m
           JOIN users u ON u.id = m.user_id WHERE m.gruppe_id = ? ORDER BY u.vorname`
        ).bind(g.id).all();
        out.push({ ...g, mitglieder: mitglieder.map((m) => ({ ...m, avatar: avatarFor(m) })) });
      }
      return json({ gruppen: out });
    }

    if (path === "/gruppen" && method === "POST") {
      if (!canAssign) return err("Keine Berechtigung, Gruppen anzulegen.", 403);
      const { name, farbe, beschreibung } = body;
      if (!name || !name.trim()) return err("Gruppenname fehlt.");
      const existing = await env.DB.prepare("SELECT id FROM bau_gruppen WHERE name = ?").bind(name.trim()).first();
      if (existing) return err("Diese Gruppe existiert bereits.");
      const res = await env.DB.prepare(
        `INSERT INTO bau_gruppen (name, farbe, beschreibung, erstellt_von, erstellt_am) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(name.trim(), farbe || "#5f8fc4", (beschreibung || "").trim(), user.id, nowIso())
        .run();
      return json({ id: res.meta.last_row_id });
    }

    const gruppeDeleteMatch = path.match(/^\/gruppen\/(\d+)$/);
    if (gruppeDeleteMatch && method === "DELETE") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const id = gruppeDeleteMatch[1];
      await env.DB.prepare("DELETE FROM bau_gruppen_mitglieder WHERE gruppe_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM bau_gruppen WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    const gruppeAddMatch = path.match(/^\/gruppen\/(\d+)\/mitglieder$/);
    if (gruppeAddMatch && method === "POST") {
      if (!canAssign) return err("Keine Berechtigung.", 403);
      const gruppeId = gruppeAddMatch[1];
      const { user_id } = body;
      const target = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND aktiv = 1 AND freigegeben = 1").bind(user_id).first();
      if (!target) return err("Spieler nicht gefunden.", 404);
      await env.DB.prepare("INSERT OR IGNORE INTO bau_gruppen_mitglieder (gruppe_id, user_id) VALUES (?, ?)").bind(gruppeId, target.id).run();
      return json({ ok: true });
    }

    const gruppeRemoveMatch = path.match(/^\/gruppen\/(\d+)\/mitglieder\/(\d+)$/);
    if (gruppeRemoveMatch && method === "DELETE") {
      if (!canAssign) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("DELETE FROM bau_gruppen_mitglieder WHERE gruppe_id = ? AND user_id = ?")
        .bind(gruppeRemoveMatch[1], gruppeRemoveMatch[2]).run();
      return json({ ok: true });
    }

    // ---- KALENDER ----

    if (path === "/kalender" && method === "GET") {
      const { results: eintraege } = await env.DB.prepare(
        "SELECT * FROM kalender_eintraege ORDER BY datum ASC, zeit ASC LIMIT 300"
      ).all();
      const out = [];
      for (const e of eintraege) {
        const { base: beschreibungBase, erw } = unpackMeta(e.beschreibung);
        const basis = { ...e, beschreibung: beschreibungBase, erwartete_sekunden: erw };
        if (e.typ === "EVENT") {
          const { results: votes } = await env.DB.prepare(
            "SELECT user_id, antwort, user_name FROM kalender_abstimmung WHERE entry_id = ?"
          ).bind(e.id).all();
          out.push({
            ...basis,
            votes,
            zeit_count: votes.filter((v) => v.antwort === "ZEIT").length,
            keine_zeit_count: votes.filter((v) => v.antwort === "KEINE_ZEIT").length,
            meine_stimme: (votes.find((v) => v.user_id === user.id) || {}).antwort || null,
          });
        } else {
          out.push(basis);
        }
      }
      return json({ eintraege: out });
    }

    if (path === "/kalender" && method === "POST") {
      if (!canKalender) return err("Dafür fehlt dir die Berechtigung.", 403);
      const { typ, titel, beschreibung, datum, zeit } = body;
      if (!titel || !titel.trim()) return err("Titel fehlt.");
      if (!datum) return err("Datum fehlt.");
      const t = typ === "EVENT" ? "EVENT" : "EINTRAG";
      const erwSek = Math.max(0, parseInt(body.erwartete_minuten) || 0) * 60;
      // Dauer wird hinter der eigentlichen Beschreibung (unsichtbar) mitgespeichert —
      // genau wie bei Aufgaben/Layern, damit keine D1-Migration nötig ist.
      const beschreibungWert = packMeta((beschreibung || "").trim(), { erw: erwSek });
      const res = await env.DB.prepare(
        `INSERT INTO kalender_eintraege (typ, titel, beschreibung, datum, zeit, erstellt_von, ersteller_name, erstellt_am)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(t, titel.trim(), beschreibungWert, datum, zeit || null, user.id, meName, nowIso())
        .run();

      if (t === "EVENT") {
        const { results: alle } = await env.DB.prepare("SELECT id FROM users WHERE aktiv = 1 AND freigegeben = 1").all();
        await notifyMany(
          env,
          alle.map((u) => u.id).filter((id) => id !== user.id),
          "EVENT_NEU",
          "Neues Event: " + titel.trim(),
          `${meName} hat ein Event für den ${datum}${zeit ? " um " + zeit + " Uhr" : ""} erstellt. Stimm ab, ob du Zeit hast!`,
          "kalender"
        );
      }
      return json({ id: res.meta.last_row_id });
    }

    const kalenderDeleteMatch = path.match(/^\/kalender\/(\d+)$/);
    if (kalenderDeleteMatch && method === "DELETE") {
      const id = kalenderDeleteMatch[1];
      const entry = await env.DB.prepare("SELECT * FROM kalender_eintraege WHERE id = ?").bind(id).first();
      if (!entry) return err("Eintrag nicht gefunden.", 404);
      if (!user.is_admin && entry.erstellt_von !== user.id) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("DELETE FROM kalender_abstimmung WHERE entry_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM kalender_eintraege WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    const kalenderVoteMatch = path.match(/^\/kalender\/(\d+)\/vote$/);
    if (kalenderVoteMatch && method === "POST") {
      const id = kalenderVoteMatch[1];
      const entry = await env.DB.prepare("SELECT * FROM kalender_eintraege WHERE id = ? AND typ = 'EVENT'").bind(id).first();
      if (!entry) return err("Event nicht gefunden.", 404);
      const { antwort } = body;
      if (!["ZEIT", "KEINE_ZEIT"].includes(antwort)) return err("Ungültige Abstimmung.");
      await env.DB.prepare(
        `INSERT INTO kalender_abstimmung (entry_id, user_id, antwort, user_name) VALUES (?, ?, ?, ?)
         ON CONFLICT(entry_id, user_id) DO UPDATE SET antwort = excluded.antwort, user_name = excluded.user_name`
      )
        .bind(id, user.id, antwort, meName)
        .run();
      return json({ ok: true });
    }

    // ---- VORSCHLÄGE ----
    // Jeder angemeldete Nutzer kann einen Vorschlag einreichen, der Admin
    // entscheidet über "annehmen"/"ablehnen". Tabelle wird beim ersten
    // Zugriff automatisch angelegt.

    if (path === "/vorschlaege" && method === "GET") {
      await ensureVorschlaegeTable(env);
      const { results } = await env.DB.prepare(
        "SELECT * FROM vorschlaege ORDER BY (status = 'OFFEN') DESC, id DESC LIMIT 300"
      ).all();
      return json({ vorschlaege: results });
    }

    if (path === "/vorschlaege" && method === "POST") {
      await ensureVorschlaegeTable(env);
      const { titel, beschreibung } = body;
      if (!titel || !titel.trim()) return err("Titel fehlt.");
      const res = await env.DB.prepare(
        `INSERT INTO vorschlaege (titel, beschreibung, status, erstellt_von, ersteller_name, erstellt_am)
         VALUES (?, ?, 'OFFEN', ?, ?, ?)`
      )
        .bind(titel.trim(), (beschreibung || "").trim(), user.id, meName, nowIso())
        .run();
      await notifyAdmins(
        env,
        "VORSCHLAG_NEU",
        "Neuer Vorschlag",
        `${meName} hat einen Vorschlag eingereicht: „${titel.trim()}"`,
        "vorschlaege",
        user.id
      );
      return json({ id: res.meta.last_row_id });
    }

    const vorschlagDecideMatch = path.match(/^\/vorschlaege\/(\d+)\/entscheiden$/);
    if (vorschlagDecideMatch && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      await ensureVorschlaegeTable(env);
      const id = vorschlagDecideMatch[1];
      const v = await env.DB.prepare("SELECT * FROM vorschlaege WHERE id = ?").bind(id).first();
      if (!v) return err("Vorschlag nicht gefunden.", 404);
      const status = body.status === "ANGENOMMEN" ? "ANGENOMMEN" : body.status === "ABGELEHNT" ? "ABGELEHNT" : null;
      if (!status) return err("Ungültiger Status.");
      await env.DB.prepare("UPDATE vorschlaege SET status = ? WHERE id = ?").bind(status, id).run();
      await notify(
        env,
        v.erstellt_von,
        "VORSCHLAG_ENTSCHIEDEN",
        status === "ANGENOMMEN" ? "Vorschlag angenommen" : "Vorschlag abgelehnt",
        `Dein Vorschlag „${v.titel}" wurde ${status === "ANGENOMMEN" ? "angenommen ✅" : "abgelehnt ❌"}.`,
        "vorschlaege"
      );
      return json({ ok: true });
    }

    const vorschlagDeleteMatch = path.match(/^\/vorschlaege\/(\d+)$/);
    if (vorschlagDeleteMatch && method === "DELETE") {
      await ensureVorschlaegeTable(env);
      const id = vorschlagDeleteMatch[1];
      const v = await env.DB.prepare("SELECT * FROM vorschlaege WHERE id = ?").bind(id).first();
      if (!v) return err("Vorschlag nicht gefunden.", 404);
      if (!user.is_admin && v.erstellt_von !== user.id) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("DELETE FROM vorschlaege WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    // ---- BENACHRICHTIGUNGEN ----

    if (path === "/notifications" && method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM benachrichtigungen WHERE user_id = ? ORDER BY id DESC LIMIT 50"
      ).bind(user.id).all();
      return json({ notifications: results });
    }

    if (path === "/notifications/count" && method === "GET") {
      const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM benachrichtigungen WHERE user_id = ? AND gelesen = 0").bind(user.id).first();
      return json({ unread: row.c || 0 });
    }

    if (path === "/notifications/read-all" && method === "POST") {
      await env.DB.prepare("UPDATE benachrichtigungen SET gelesen = 1 WHERE user_id = ? AND gelesen = 0").bind(user.id).run();
      return json({ ok: true });
    }

    const notifReadMatch = path.match(/^\/notifications\/(\d+)\/read$/);
    if (notifReadMatch && method === "POST") {
      await env.DB.prepare("UPDATE benachrichtigungen SET gelesen = 1 WHERE id = ? AND user_id = ?")
        .bind(notifReadMatch[1], user.id).run();
      return json({ ok: true });
    }

    // ---- DOKUMENTE & DATEIEN ----

    if (path === "/dateien" && method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, dateiname, beschreibung, groesse_bytes, content_type, hochgeladen_name, hochgeladen_am FROM dateien ORDER BY id DESC"
      ).all();
      return json({ dateien: results });
    }

    if (path === "/dateien/upload" && method === "POST") {
      if (!user.is_admin) return err("Nur der Admin kann Dateien hochladen.", 403);
      if (!env.FILES) return err("Datei-Speicher (R2) ist nicht eingerichtet. Siehe README.md.", 500);
      if (!contentType.includes("multipart/form-data")) return err("Ungültige Anfrage.");
      const form = await request.formData();
      const file = form.get("datei");
      if (!file || typeof file === "string") return err("Keine Datei ausgewählt.");
      if (file.size > 100 * 1024 * 1024) return err("Datei zu groß (max. 100 MB).");
      const beschreibung = (form.get("beschreibung") || "").toString().slice(0, 500);
      const safeName = sanitizeDateiname(file.name);
      const r2Key = `${Date.now()}-${randHex(6)}-${safeName}`;
      await env.FILES.put(r2Key, file.stream(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
      });
      const res = await env.DB.prepare(
        `INSERT INTO dateien (dateiname, beschreibung, groesse_bytes, content_type, r2_key, hochgeladen_von, hochgeladen_name, hochgeladen_am)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(safeName, beschreibung, file.size, file.type || "application/octet-stream", r2Key, user.id, meName, nowIso())
        .run();
      await notifyAllActive(
        env,
        "DATEI_NEU",
        "Neues Dokument verfügbar",
        `${meName} hat „${safeName}" hochgeladen.`,
        "dateien",
        user.id
      );
      return json({ id: res.meta.last_row_id });
    }

    const dateiDownloadMatch = path.match(/^\/dateien\/(\d+)\/download$/);
    if (dateiDownloadMatch && method === "GET") {
      if (!env.FILES) return err("Datei-Speicher (R2) ist nicht eingerichtet.", 500);
      const datei = await env.DB.prepare("SELECT * FROM dateien WHERE id = ?").bind(dateiDownloadMatch[1]).first();
      if (!datei) return err("Datei nicht gefunden.", 404);
      const obj = await env.FILES.get(datei.r2_key);
      if (!obj) return err("Datei nicht mehr im Speicher vorhanden.", 404);
      return new Response(obj.body, {
        headers: {
          "content-type": datei.content_type || "application/octet-stream",
          "content-disposition": `attachment; filename="${datei.dateiname.replace(/"/g, "")}"`,
          "content-length": String(datei.groesse_bytes),
        },
      });
    }

    const dateiDeleteMatch = path.match(/^\/dateien\/(\d+)$/);
    if (dateiDeleteMatch && method === "DELETE") {
      if (!user.is_admin) return err("Nur der Admin kann Dateien löschen.", 403);
      const datei = await env.DB.prepare("SELECT * FROM dateien WHERE id = ?").bind(dateiDeleteMatch[1]).first();
      if (!datei) return err("Datei nicht gefunden.", 404);
      if (env.FILES) await env.FILES.delete(datei.r2_key);
      await env.DB.prepare("DELETE FROM dateien WHERE id = ?").bind(dateiDeleteMatch[1]).run();
      return json({ ok: true });
    }

    // ---- ZEITLOG ----

    if (path === "/zeitlog" && method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM sessions WHERE status = 'OFF' ORDER BY id DESC LIMIT 300"
      ).all();
      return json({ zeitlog: results });
    }

    if (path === "/zeitlog/export" && method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM sessions WHERE status = 'OFF' ORDER BY id DESC"
      ).all();
      const header = "Datum,Gamertag,Start,Ende,Dauer_Std,Session-ID\n";
      const rows = results
        .map((r) => `${r.datum},${r.gamertag},${r.start},${r.ende},${(r.dauer_std || 0).toFixed(2)},${r.session_code || ""}`)
        .join("\n");
      return new Response(header + rows, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="zeitlog.csv"',
        },
      });
    }

    // ---- LEADERBOARD ----

    if (path === "/leaderboard" && method === "GET") {
      const { results: users } = await env.DB.prepare("SELECT * FROM users WHERE aktiv = 1 AND freigegeben = 1").all();
      const rows = [];
      for (const u of users) {
        const gesamt = await totalHoursFor(env, u.gamertag);
        if (gesamt <= 0) continue;
        const sessRow = await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM sessions WHERE gamertag = ? AND status = 'OFF'"
        )
          .bind(u.gamertag)
          .first();
        const heute = await todayHoursFor(env, u.gamertag);
        const open = await openSessionFor(env, u.gamertag);
        rows.push({
          gamertag: u.gamertag,
          name: `${u.vorname} ${u.nachname}`,
          avatar: avatarFor(u),
          gesamt_std: gesamt,
          sessions: sessRow.c,
          avg_std: sessRow.c ? gesamt / sessRow.c : 0,
          heute_std: heute,
          status: open ? "ON" : "OFF",
          punkte: u.punkte || 0,
          badge: badgeFor(gesamt).current,
        });
      }
      rows.sort((a, b) => b.gesamt_std - a.gesamt_std);
      rows.forEach((r, i) => (r.rang = i + 1));
      return json({ leaderboard: rows });
    }

    // ---- STATISTIK (Wochendiagramm) ----

    if (path === "/stats/weekly" && method === "GET") {
      const days = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push(d.toISOString().slice(0, 10));
      }
      const out = [];
      for (const d of days) {
        const row = await env.DB.prepare(
          "SELECT COALESCE(SUM(dauer_std),0) AS h FROM sessions WHERE gamertag = ? AND status='OFF' AND datum = ?"
        )
          .bind(user.gamertag, d)
          .first();
        out.push({ datum: d, std: row.h || 0 });
      }
      return json({ weekly: out });
    }

    // ---- LOG & PROFIL-ÜBERSICHT (ab bestimmtem Rang / Admin) ----

    if (path === "/statistik/log" && method === "GET") {
      if (!canSeeStats) return err("Dafür fehlt dir die Berechtigung.", 403);
      const { results: sess } = await env.DB.prepare(
        "SELECT s.*, u.id AS uid, u.vorname, u.nachname FROM sessions s JOIN users u ON u.gamertag = s.gamertag WHERE s.status = 'OFF' ORDER BY s.id DESC LIMIT 300"
      ).all();
      const out = [];
      for (const s of sess) {
        const doneRow = await env.DB.prepare(
          `SELECT COUNT(*) AS c FROM tasks WHERE zustaendig_user_id = ? AND status = 'ERLEDIGT' AND end_zeit >= ? AND end_zeit <= ?`
        )
          .bind(s.uid, s.start, s.ende)
          .first();
        out.push({
          name: `${s.vorname} ${s.nachname}`,
          gamertag: s.gamertag,
          datum: s.datum,
          start: s.start,
          ende: s.ende,
          dauer_std: s.dauer_std,
          aufgaben_erledigt: doneRow.c || 0,
        });
      }
      return json({ log: out });
    }

    if (path === "/statistik/profile" && method === "GET") {
      if (!canSeeStats) return err("Dafür fehlt dir die Berechtigung.", 403);
      const { results: users2 } = await env.DB.prepare(
        `SELECT u.*, r.name AS rank_name, r.farbe AS rank_farbe FROM users u LEFT JOIN ranks r ON r.id = u.rank_id ORDER BY u.vorname`
      ).all();
      const out = [];
      for (const u of users2) {
        const gesamt = await totalHoursFor(env, u.gamertag);
        const erledigt = await completedTasksCountFor(env, u.id);
        out.push({
          vorname: u.vorname,
          nachname: u.nachname,
          gamertag: u.gamertag,
          konto_id: u.konto_id,
          avatar: avatarFor(u),
          rang: u.is_admin ? "Admin" : (u.rank_name || "–"),
          rang_farbe: u.is_admin ? "#f2c744" : (u.rank_farbe || "#9a9ca3"),
          aktiv: !!u.aktiv,
          gesamt_std: gesamt,
          aufgaben_erledigt: erledigt,
          punkte: u.punkte || 0,
        });
      }
      return json({ profile: out });
    }

    // ---- ADMIN ----

    if (path === "/admin/konten" && method === "GET") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const { results } = await env.DB.prepare(
        `SELECT u.id, u.vorname, u.nachname, u.gamertag, u.konto_id, u.erstellt, u.aktiv, u.freigegeben, u.is_admin,
                u.letzter_login, u.rank_id, u.punkte, r.name AS rank_name
         FROM users u LEFT JOIN ranks r ON r.id = u.rank_id ORDER BY u.freigegeben ASC, u.id`
      ).all();
      return json({ konten: results });
    }

    const toggleMatch = path.match(/^\/admin\/konten\/(\d+)\/toggle$/);
    if (toggleMatch && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const id = toggleMatch[1];
      const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
      if (!target) return err("Konto nicht gefunden.", 404);
      await env.DB.prepare("UPDATE users SET aktiv = ? WHERE id = ?").bind(target.aktiv ? 0 : 1, id).run();
      return json({ ok: true });
    }

    const addPointsMatch = path.match(/^\/admin\/konten\/(\d+)\/punkte$/);
    if (addPointsMatch && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const id = addPointsMatch[1];
      const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
      if (!target) return err("Konto nicht gefunden.", 404);
      const delta = parseInt(body.punkte);
      if (!Number.isFinite(delta) || delta === 0) return err("Bitte eine gültige Punktzahl ungleich 0 angeben.");
      await addPunkte(env, target.id, delta);
      await notify(
        env,
        target.id,
        "PUNKTE_GUTSCHRIFT",
        delta > 0 ? "Punkte gutgeschrieben" : "Punkte abgezogen",
        `${meName} hat dir ${delta > 0 ? "+" : ""}${delta} Punkte gebucht.`,
        "shop"
      );
      return json({ ok: true });
    }

    const approveMatch = path.match(/^\/admin\/konten\/(\d+)\/approve$/);
    if (approveMatch && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const id = approveMatch[1];
      const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
      if (!target) return err("Konto nicht gefunden.", 404);
      await env.DB.prepare("UPDATE users SET freigegeben = 1 WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    const rejectMatch = path.match(/^\/admin\/konten\/(\d+)\/reject$/);
    if (rejectMatch && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const id = rejectMatch[1];
      const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
      if (!target) return err("Konto nicht gefunden.", 404);
      if (target.freigegeben) return err("Konto ist bereits freigegeben.");
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    const setRankMatch = path.match(/^\/admin\/konten\/(\d+)\/rang$/);
    if (setRankMatch && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const id = setRankMatch[1];
      const { rank_id } = body;
      const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
      if (!target) return err("Konto nicht gefunden.", 404);
      const rank = await env.DB.prepare("SELECT * FROM ranks WHERE id = ?").bind(rank_id).first();
      if (!rank) return err("Rang nicht gefunden.", 404);
      await env.DB.prepare("UPDATE users SET rank_id = ? WHERE id = ?").bind(rank.id, id).run();
      return json({ ok: true });
    }

    return err("Nicht gefunden.", 404);
  } catch (e) {
    return err("Serverfehler: " + e.message, 500);
  }
}
