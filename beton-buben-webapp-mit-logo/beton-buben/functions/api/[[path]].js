// BETON-BUBEN · STADIONBAU — Backend-API
// Läuft als Cloudflare Pages Function unter /api/*
// Benötigt: D1-Binding "DB" + Secret "JWT_SECRET" (siehe README.md)

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
    // Datei-Uploads kommen als multipart/form-data — die JSON-Body-Verarbeitung
    // hier überspringen, sonst ist der Request-Stream schon "verbraucht", bevor
    // die Datei-Route weiter unten request.formData() aufrufen kann.
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
      // Alle weiteren Konten müssen erst von einem Admin freigegeben werden.
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

    // ---- ONLINE-ZEIT ----

    if (path === "/session/toggle" && method === "POST") {
      const open = await openSessionFor(env, user.gamertag);
      if (open) {
        const start = new Date(open.start);
        const ende = new Date();
        const dauer = (ende - start) / 1000 / 3600;
        await env.DB.prepare(
          "UPDATE sessions SET ende = ?, dauer_std = ?, status = 'OFF' WHERE id = ?"
        )
          .bind(ende.toISOString(), dauer, open.id)
          .run();
        return json({ online: false, dauer_std: dauer });
      } else {
        const code = "S-" + randHex(4).toUpperCase();
        await env.DB.prepare(
          `INSERT INTO sessions (user_id, gamertag, datum, start, status, quelle, session_code)
           VALUES (?, ?, ?, ?, 'ON', 'WEB', ?)`
        )
          .bind(user.id, user.gamertag, todayStr(), nowIso(), code)
          .run();
        return json({ online: true, seit: nowIso() });
      }
    }

    if (path === "/session/status" && method === "GET") {
      const open = await openSessionFor(env, user.gamertag);
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

    // ---- RÄNGE ----

    if (path === "/ranks" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM ranks ORDER BY level DESC").all();
      return json({ ranks: results });
    }

    if (path === "/ranks" && method === "POST") {
      if (!user.is_admin) return err("Nur für Admins.", 403);
      const { name, level, kann_aufgaben_zuweisen, kann_statistiken_sehen, kann_kalender_erstellen, farbe } = body;
      if (!name || !name.trim()) return err("Rangname fehlt.");
      if (name.trim().toLowerCase() === "sklave") return err("Der Rang „Sklave" existiert bereits als niedrigster Rang.");
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
      if (rank.name === "Sklave") return err("Der Rang „Sklave" kann nicht gelöscht werden.");
      const inUse = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE rank_id = ?").bind(id).first();
      if (inUse.c > 0) return err("Diesem Rang sind noch Spieler zugeordnet — erst umverteilen.");
      await env.DB.prepare("DELETE FROM ranks WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    // ---- AUFGABEN ----

    if (path === "/tasks" && method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM tasks ORDER BY id DESC LIMIT 200").all();
      return json({ tasks: results });
    }

    if (path === "/tasks" && method === "POST") {
      const { titel, notiz, prioritaet, zustaendig_user_id, punkte } = body;
      if (!titel || !titel.trim()) return err("Aufgabentitel fehlt.");

      let zId = null;
      let zName = null;
      let zugewiesenVon = null;
      if (zustaendig_user_id) {
        if (!canAssign) return err("Keine Berechtigung, Aufgaben zuzuweisen.", 403);
        const target = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND aktiv = 1 AND freigegeben = 1").bind(zustaendig_user_id).first();
        if (!target) return err("Spieler nicht gefunden.", 404);
        zId = target.id;
        zName = `${target.vorname} ${target.nachname}`;
        zugewiesenVon = user.id;
      }

      // Nur der Admin darf festlegen, wie viele Punkte eine Aufgabe bringt.
      const pkt = user.is_admin ? Math.max(0, parseInt(punkte) || 0) : 0;

      const res = await env.DB.prepare(
        `INSERT INTO tasks (titel, zustaendig_user_id, zustaendig_name, zugewiesen_von, status, prioritaet, notiz, erstellt_am, erstellt_von, punkte)
         VALUES (?, ?, ?, ?, 'OFFEN', ?, ?, ?, ?, ?)`
      )
        .bind(titel.trim(), zId, zName, zugewiesenVon, prioritaet || "NORMAL", notiz || "", nowIso(), user.id, pkt)
        .run();

      if (zId) {
        await notify(env, zId, "AUFGABE_ZUGEWIESEN", "Neue Aufgabe zugewiesen", `${meName} hat dir „${titel.trim()}" zugewiesen.`, "aufgaben");
      }
      return json({ id: res.meta.last_row_id });
    }

    const taskStartMatch = path.match(/^\/tasks\/(\d+)\/start$/);
    if (taskStartMatch && method === "POST") {
      const id = taskStartMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      if (task.status !== "OFFEN") return err("Aufgabe kann nicht gestartet werden.");
      if (task.zustaendig_user_id && task.zustaendig_user_id !== user.id && !canAssign) {
        return err("Diese Aufgabe ist bereits jemand anderem zugewiesen.", 403);
      }
      await env.DB.prepare(
        "UPDATE tasks SET status = 'LAEUFT', start_zeit = ?, zustaendig_user_id = ?, zustaendig_name = ? WHERE id = ?"
      )
        .bind(nowIso(), task.zustaendig_user_id || user.id, task.zustaendig_name || meName, id)
        .run();
      return json({ ok: true });
    }

    const taskPauseMatch = path.match(/^\/tasks\/(\d+)\/pause$/);
    if (taskPauseMatch && method === "POST") {
      const id = taskPauseMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      if (task.status !== "LAEUFT") return err("Nur laufende Aufgaben können pausiert werden.");
      if (task.zustaendig_user_id && task.zustaendig_user_id !== user.id && !canAssign) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("UPDATE tasks SET status = 'PAUSIERT' WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    const taskResumeMatch = path.match(/^\/tasks\/(\d+)\/resume$/);
    if (taskResumeMatch && method === "POST") {
      const id = taskResumeMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      if (task.status !== "PAUSIERT") return err("Nur pausierte Aufgaben können fortgesetzt werden.");
      if (task.zustaendig_user_id && task.zustaendig_user_id !== user.id && !canAssign) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("UPDATE tasks SET status = 'LAEUFT' WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    const taskCompleteMatch = path.match(/^\/tasks\/(\d+)\/complete$/);
    if (taskCompleteMatch && method === "POST") {
      const id = taskCompleteMatch[1];
      const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
      if (!task) return err("Aufgabe nicht gefunden.", 404);
      if (task.zustaendig_user_id && task.zustaendig_user_id !== user.id && !canAssign) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("UPDATE tasks SET status = 'ERLEDIGT', end_zeit = ? WHERE id = ?")
        .bind(nowIso(), id)
        .run();
      const empfaenger = task.zustaendig_user_id || user.id;
      if (task.punkte > 0) await addPunkte(env, empfaenger, task.punkte);
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
      return json({ layers: results });
    }

    if (path === "/stadion/layers" && method === "POST") {
      if (!canAssign) return err("Keine Berechtigung, Stadion-Layer anzulegen.", 403);
      const { name, punkte, zustaendig_user_id } = body;
      if (!name || !name.trim()) return err("Name der Layer fehlt.");
      const maxRow = await env.DB.prepare("SELECT COALESCE(MAX(layer_nr),0) AS m FROM stadium_layers").first();
      const nr = (maxRow.m || 0) + 1;

      let zId = null, zName = null, zugewiesenVon = null;
      if (zustaendig_user_id) {
        const target = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND aktiv = 1 AND freigegeben = 1").bind(zustaendig_user_id).first();
        if (!target) return err("Spieler nicht gefunden.", 404);
        zId = target.id; zName = `${target.vorname} ${target.nachname}`; zugewiesenVon = user.id;
      }
      const pkt = user.is_admin ? Math.max(0, parseInt(punkte) || 0) : 0;

      const res = await env.DB.prepare(
        `INSERT INTO stadium_layers (layer_nr, name, status, zustaendig_user_id, zustaendig_name, zugewiesen_von, punkte, erstellt_am, erstellt_von)
         VALUES (?, ?, 'OFFEN', ?, ?, ?, ?, ?, ?)`
      )
        .bind(nr, name.trim(), zId, zName, zugewiesenVon, pkt, nowIso(), user.id)
        .run();

      if (zId) await notify(env, zId, "LAYER_ZUGEWIESEN", "Stadion-Layer zugewiesen", `${meName} hat dir die Layer „${name.trim()}" zugewiesen.`, "stadion");
      return json({ id: res.meta.last_row_id, layer_nr: nr });
    }

    const layerAssignMatch = path.match(/^\/stadion\/layers\/(\d+)\/zuweisen$/);
    if (layerAssignMatch && method === "POST") {
      if (!canAssign) return err("Keine Berechtigung.", 403);
      const id = layerAssignMatch[1];
      const layer = await env.DB.prepare("SELECT * FROM stadium_layers WHERE id = ?").bind(id).first();
      if (!layer) return err("Layer nicht gefunden.", 404);
      const { user_id } = body;
      let zId = null, zName = null;
      if (user_id) {
        const target = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND aktiv = 1 AND freigegeben = 1").bind(user_id).first();
        if (!target) return err("Spieler nicht gefunden.", 404);
        zId = target.id; zName = `${target.vorname} ${target.nachname}`;
      }
      await env.DB.prepare("UPDATE stadium_layers SET zustaendig_user_id = ?, zustaendig_name = ?, zugewiesen_von = ? WHERE id = ?")
        .bind(zId, zName, user.id, id).run();
      if (zId) await notify(env, zId, "LAYER_ZUGEWIESEN", "Stadion-Layer zugewiesen", `${meName} hat dir die Layer „${layer.name}" zugewiesen.`, "stadion");
      return json({ ok: true });
    }

    const layerStartMatch = path.match(/^\/stadion\/layers\/(\d+)\/start$/);
    if (layerStartMatch && method === "POST") {
      const id = layerStartMatch[1];
      const layer = await env.DB.prepare("SELECT * FROM stadium_layers WHERE id = ?").bind(id).first();
      if (!layer) return err("Layer nicht gefunden.", 404);
      if (layer.status !== "OFFEN") return err("Layer kann nicht gestartet werden.");
      if (layer.zustaendig_user_id && layer.zustaendig_user_id !== user.id && !canAssign) return err("Diese Layer ist bereits jemand anderem zugewiesen.", 403);
      await env.DB.prepare("UPDATE stadium_layers SET status = 'LAEUFT', start_zeit = ?, zustaendig_user_id = ?, zustaendig_name = ? WHERE id = ?")
        .bind(nowIso(), layer.zustaendig_user_id || user.id, layer.zustaendig_name || meName, id).run();
      return json({ ok: true });
    }

    const layerPauseMatch = path.match(/^\/stadion\/layers\/(\d+)\/pause$/);
    if (layerPauseMatch && method === "POST") {
      const id = layerPauseMatch[1];
      const layer = await env.DB.prepare("SELECT * FROM stadium_layers WHERE id = ?").bind(id).first();
      if (!layer) return err("Layer nicht gefunden.", 404);
      if (layer.status !== "LAEUFT") return err("Nur laufende Layer können pausiert werden.");
      if (layer.zustaendig_user_id && layer.zustaendig_user_id !== user.id && !canAssign) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("UPDATE stadium_layers SET status = 'PAUSIERT' WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    const layerResumeMatch = path.match(/^\/stadion\/layers\/(\d+)\/resume$/);
    if (layerResumeMatch && method === "POST") {
      const id = layerResumeMatch[1];
      const layer = await env.DB.prepare("SELECT * FROM stadium_layers WHERE id = ?").bind(id).first();
      if (!layer) return err("Layer nicht gefunden.", 404);
      if (layer.status !== "PAUSIERT") return err("Nur pausierte Layer können fortgesetzt werden.");
      if (layer.zustaendig_user_id && layer.zustaendig_user_id !== user.id && !canAssign) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("UPDATE stadium_layers SET status = 'LAEUFT' WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    const layerCompleteMatch = path.match(/^\/stadion\/layers\/(\d+)\/complete$/);
    if (layerCompleteMatch && method === "POST") {
      const id = layerCompleteMatch[1];
      const layer = await env.DB.prepare("SELECT * FROM stadium_layers WHERE id = ?").bind(id).first();
      if (!layer) return err("Layer nicht gefunden.", 404);
      if (layer.zustaendig_user_id && layer.zustaendig_user_id !== user.id && !canAssign) return err("Keine Berechtigung.", 403);
      await env.DB.prepare("UPDATE stadium_layers SET status = 'FERTIG', end_zeit = ? WHERE id = ?").bind(nowIso(), id).run();
      const empfaenger = layer.zustaendig_user_id || user.id;
      if (layer.punkte > 0) await addPunkte(env, empfaenger, layer.punkte);
      await notifyMany(
        env,
        [layer.zugewiesen_von].filter((x) => x && x !== user.id),
        "LAYER_FERTIG",
        "Stadion-Layer fertiggestellt",
        `${meName} hat die Layer „${layer.name}" fertiggestellt. Das Stadion wächst! 🏟️`,
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
        if (e.typ === "EVENT") {
          const { results: votes } = await env.DB.prepare(
            "SELECT user_id, antwort, user_name FROM kalender_abstimmung WHERE entry_id = ?"
          ).bind(e.id).all();
          out.push({
            ...e,
            votes,
            zeit_count: votes.filter((v) => v.antwort === "ZEIT").length,
            keine_zeit_count: votes.filter((v) => v.antwort === "KEINE_ZEIT").length,
            meine_stimme: (votes.find((v) => v.user_id === user.id) || {}).antwort || null,
          });
        } else {
          out.push(e);
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
      const res = await env.DB.prepare(
        `INSERT INTO kalender_eintraege (typ, titel, beschreibung, datum, zeit, erstellt_von, ersteller_name, erstellt_am)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(t, titel.trim(), (beschreibung || "").trim(), datum, zeit || null, user.id, meName, nowIso())
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
