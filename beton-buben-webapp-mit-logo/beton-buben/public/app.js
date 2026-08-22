const API = "/api";
let state = {
  token: localStorage.getItem("bb_token") || null,
  me: null,
  view: "dashboard",
  tickHandle: null,
  notifHandle: null,
  notifOpen: false,
  lastNotifId: 0,
  notifPermAsked: false,
  blockLayers: null,      // Cache der Litematica-Blocklisten (aus /block-layers)
  blockFocusNr: null,     // Welcher Block-Layer beim Öffnen des Blöcke-Tabs fokussiert werden soll
  zeitstrahlDatum: null,  // Aktuell gewähltes Datum im Zeitstrahl-Tab (YYYY-MM-DD)
  zeitstrahlHandle: null, // Live-Update-Intervall, damit überzogene/laufende Termine im Zeitstrahl live weiterwachsen
};

const $app = document.getElementById("app");
const $topbar = document.getElementById("topbar");
const $tabs = document.getElementById("tabs");
const $whoName = document.getElementById("whoName");

// ---------- API-Helfer ----------

async function api(path, opts = {}) {
  const headers = { "content-type": "application/json" };
  if (state.token) headers.authorization = "Bearer " + state.token;
  const res = await fetch(API + path, { ...opts, headers });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || "Fehler (" + res.status + ")");
  return data;
}

function setToken(token) {
  state.token = token;
  if (token) localStorage.setItem("bb_token", token);
  else localStorage.removeItem("bb_token");
}

// ---------- Formatierung ----------

function fmtStd(h) {
  return (h || 0).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function fmtDatumKurz(datum) {
  if (!datum) return "–";
  const d = new Date(datum + "T00:00:00");
  return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
// Countdown-Formatierung für die erwartete Zeit einer Aufgabe/Layer: zählt ab dem
// erwarteten Wert runter, läuft bei Überschreitung mit "+" ins Minus.
function fmtCountdown(remainingSeconds) {
  const overtime = remainingSeconds < 0;
  const s = Math.abs(Math.round(remainingSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return (overtime ? "+" : "") + `${hh}:${mm}:${ss}`;
}
// Statische HH:MM-Anzeige einer Gesamtdauer (z. B. gesetzte erwartete Zeit
// einer noch nicht gestarteten Aufgabe/Layer) — ohne Sekunden, ohne Countdown.
function fmtHM(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${hh}:${mm}`;
}
// Kurze Anzeige eines geplanten Termins, z. B. "28.06.2026" oder "28.06.2026 · 16:00 Uhr".
function fmtTerminKurz(datum, zeit) {
  if (!datum) return "";
  const d = new Date(datum + "T00:00:00");
  const tag = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  return zeit ? `${tag} · ${zeit} Uhr` : tag;
}

// Wandelt Zeilenumbrüche in <br> um — für mehrzeilige, schöner formatierte Texte
// (z. B. Beschreibungen bei Kalender-/Event-Einträgen oder Vorschlägen). Erwartet
// bereits escapten Text als Eingabe.
function nl2br(escapedText) {
  return String(escapedText || "").replace(/\n/g, "<br>");
}

// ---------- Avatare ----------

function avatarHtml(avatar, size) {
  size = size || 28;
  if (!avatar) return `<span class="avatar-chip" style="width:${size}px;height:${size}px;font-size:${size * 0.55}px;">👷</span>`;
  if (avatar.typ === "emoji") {
    return `<span class="avatar-chip" style="width:${size}px;height:${size}px;font-size:${size * 0.55}px;">${escapeHtml(avatar.wert)}</span>`;
  }
  return `<img class="avatar-chip" src="${avatar.wert}" width="${size}" height="${size}" alt="" loading="lazy" />`;
}

const EMOJI_CHOICES = ["🧱", "🏗️", "⛏️", "🪓", "🔨", "🦺", "👷", "🧊", "🪑", "💡", "🏟️", "🏆", "🐷", "🧟", "🦧", "🐸"];

// ---------- Moderne Mehrfach-Auswahl ----------
function ensureAssignmentStyles() {
  if (document.getElementById("bb-assignment-styles")) return;
  const s = document.createElement("style");
  s.id = "bb-assignment-styles";
  s.textContent = `
    [hidden]{display:none!important}
    .assignment-mode{display:flex;gap:8px;margin:10px 0 12px;flex-wrap:wrap}
    .assignment-mode button{border:1px solid var(--border,#333);background:var(--panel,#17191d);color:var(--text,#fff);padding:8px 13px;border-radius:10px;cursor:pointer}
    .assignment-mode button.active{border-color:var(--yellow,#f2c744);box-shadow:0 0 0 1px var(--yellow,#f2c744) inset;color:var(--yellow,#f2c744)}
    .assignment-picker{position:relative;max-width:430px}
    .assignment-picker.hidden{display:none}
    .assignment-trigger{width:100%;min-height:42px;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 13px;border:1px solid var(--border,#333);border-radius:10px;background:var(--panel,#17191d);color:var(--text,#fff);cursor:pointer}
    .assignment-trigger .count{color:var(--text-dim,#aaa);font-size:.9em}
    .assignment-menu{position:absolute;z-index:1000;left:0;right:0;top:calc(100% + 6px);max-height:260px;overflow:auto;background:#15171b;border:1px solid #3a3d44;border-radius:12px;box-shadow:0 14px 35px rgba(0,0,0,.45);padding:6px}
    .assignment-option{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;cursor:pointer}
    .assignment-option:hover{background:rgba(255,255,255,.06)}
    .assignment-option input{accent-color:var(--yellow,#f2c744);width:17px;height:17px}
    .assignment-option span{display:flex;flex-direction:column}
    .assignment-option small{color:var(--text-dim,#aaa)}
    .assignment-summary{font-size:.9em;color:var(--text-dim,#aaa);margin-top:7px}
    .stadium-progress-wrap{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px;margin:10px 0 18px}
    .stadium-progress-count{white-space:nowrap;font-weight:700}
    .stadium-progress{height:14px;border-radius:999px;background:#30333a;overflow:hidden}
    .stadium-progress-fill{height:100%;border-radius:999px;background:#48b96b;transition:width .35s ease}
    .stadium-progress-percent{font-weight:700;min-width:48px;text-align:right}
    .zeit-eingabe{display:flex;align-items:center;gap:9px;background:var(--panel,#17191d);border:1px solid var(--border,#333);border-radius:10px;padding:0 12px;height:40px}
    .zeit-label{font-size:.85em;color:var(--text-dim,#aaa);white-space:nowrap}
    .zeit-felder{display:flex;align-items:center;gap:4px}
    .zeit-teil{width:36px;height:28px;background:#0f1013;border:1px solid #3a3d44;border-radius:6px;color:var(--text,#fff);text-align:center;font-variant-numeric:tabular-nums;font-weight:700;padding:0;-moz-appearance:textfield;appearance:textfield}
    .zeit-teil::-webkit-outer-spin-button,.zeit-teil::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
    .zeit-sep{color:var(--text-dim,#aaa);font-weight:700}
    .link-eingabe{flex:1;min-width:220px;height:40px}
    .task-link-btn{white-space:nowrap}
    .block-layer-nav{display:flex;flex-wrap:wrap;gap:6px;max-height:140px;overflow:auto}
    .block-layer-chip{border:1px solid var(--border,#333);background:var(--panel,#17191d);color:var(--text,#fff);padding:6px 11px;border-radius:8px;cursor:pointer;font-weight:700;font-size:.9em}
    .block-layer-chip.active{border-color:var(--yellow,#f2c744);color:var(--yellow,#f2c744);box-shadow:0 0 0 1px var(--yellow,#f2c744) inset}
    .block-layer-card.focused{border:1px solid var(--yellow,#f2c744);box-shadow:0 0 0 1px var(--yellow,#f2c744) inset}
    .block-layer-select{max-width:100%}
    .termin-eingabe{display:flex;align-items:center;gap:8px;background:var(--panel,#17191d);border:1px solid var(--border,#333);border-radius:10px;padding:0 12px;height:40px}
    .termin-eingabe input{background:#0f1013;border:1px solid #3a3d44;border-radius:6px;color:var(--text,#fff);padding:4px 8px;height:30px}
    .termin-quickedit{display:inline-flex;gap:6px;flex-wrap:wrap;margin-left:4px}
    .zeitstrahl-nav{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .zeitstrahl-wrap{overflow-x:auto;padding-bottom:6px;margin-top:12px}
    .zeitstrahl-hours{position:relative;height:22px;min-width:960px;margin-bottom:4px}
    .zeitstrahl-hour{position:absolute;transform:translateX(-50%);font-size:.78em;color:var(--text-dim,#aaa)}
    .zeitstrahl-track{position:relative;min-width:960px;background:#15171b;border:1px solid #2c2f36;border-radius:10px;overflow:hidden}
    .zeitstrahl-gridline{position:absolute;top:0;bottom:0;width:1px;background:rgba(255,255,255,.06)}
    .zeitstrahl-nowline{position:absolute;top:0;bottom:0;width:2px;background:var(--yellow,#f2c744);z-index:5}
    .zeitstrahl-block{position:absolute;border-radius:8px;background:#48b96b;color:#0c1a10;padding:6px 8px;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,.35);display:flex;flex-direction:column;justify-content:center;cursor:default;transition:left .4s ease,width .4s ease}
    .zeitstrahl-block.layer{background:#5f8fc4;color:#0c1420}
    .zeitstrahl-block.kalender{background:#d9a441;color:#2a1e05}
    .zeitstrahl-block.event{background:#b485e0;color:#241033}
    .zeitstrahl-block.laeuft{outline:2px solid var(--yellow,#f2c744)}
    .zeitstrahl-block.fertig{opacity:.55}
    .zeitstrahl-block.overtime{background:#d9534f;color:#2a0d0d}
    .zeitstrahl-block.overtime.laeuft{outline:2px solid #ffb3b3}
    .zeitstrahl-block-zeit{font-weight:800;font-size:.78em;line-height:1.1}
    .zeitstrahl-block-titel{font-size:.82em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2}
    .zeitstrahl-legende{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:.85em;color:var(--text-dim,#aaa)}
    .zeitstrahl-legende span{display:inline-flex;align-items:center;gap:6px}
    .zeitstrahl-legende i{display:inline-block;width:12px;height:12px;border-radius:3px}
    .schematic-panel .task-form{align-items:flex-end}
    .schematic-panel .num-input{width:130px;height:40px}
    @media(max-width:650px){.stadium-progress-wrap{grid-template-columns:1fr}.stadium-progress-percent{text-align:left}.assignment-picker{max-width:none}.zeitstrahl-hours,.zeitstrahl-track{min-width:720px}}
  `;
  document.head.appendChild(s);
}

function setupAssignmentPicker(root = document) {
  root.querySelectorAll("[data-assignment-picker]").forEach((picker) => {
    const trigger = picker.querySelector("[data-assignment-trigger]");
    const menu = picker.querySelector("[data-assignment-menu]");
    if (!trigger || !menu || picker.dataset.ready) return;
    picker.dataset.ready = "1";
    const update = () => {
      const checked = [...menu.querySelectorAll("input[type=checkbox]:checked")];
      const names = checked.map((x) => x.dataset.name);
      trigger.querySelector(".label").textContent = names.length
        ? names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "")
        : "Spieler auswählen …";
      trigger.querySelector(".count").textContent = names.length ? `${names.length} ausgewählt` : "";
    };
    trigger.onclick = (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    };
    menu.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.onchange = update);
    document.addEventListener("click", (e) => {
      if (!picker.contains(e.target)) menu.hidden = true;
    });
    update();
  });
}

function getSelectedAssignmentIds(form, name = "zustaendig_user_ids") {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((x) => Number(x.value)).filter(Boolean);
}

function setAssignmentMode(form, multiple) {
  const single = form.querySelector("[data-single-assignment]");
  const picker = form.querySelector("[data-multi-assignment]");
  if (!single || !picker) return;
  single.hidden = multiple;
  picker.classList.toggle("hidden", !multiple);
  form.querySelectorAll("[data-assignment-mode]").forEach((b) => b.classList.toggle("active", b.dataset.assignmentMode === (multiple ? "multiple" : "single")));
  if (!multiple) picker.querySelectorAll("input[type=checkbox]").forEach((x) => x.checked = false);
  if (multiple) single.value = "";
  setupAssignmentPicker(form);
}

// Liest das HH:MM-Eingabefeld für die erwartete Zeit aus einem Formular
// und liefert die Gesamtminuten (Stunden werden nicht künstlich begrenzt,
// Minuten auf 0–59 geklemmt, damit "70 Minuten" nicht versehentlich als
// gültiger Wert durchrutscht).
function getErwarteteMinuten(form) {
  const stdEl = form.querySelector('[name="erwartete_std"]');
  const minEl = form.querySelector('[name="erwartete_min"]');
  const std = Math.max(0, parseInt(stdEl && stdEl.value) || 0);
  const min = Math.max(0, Math.min(59, parseInt(minEl && minEl.value) || 0));
  return std * 60 + min;
}

function zeitEingabeHtml() {
  return `
    <div class="zeit-eingabe" title="Optional: Countdown ab Start. Läuft ins Minus, wenn überschritten.">
      <span class="zeit-label">⏳ Erwartete Zeit</span>
      <div class="zeit-felder">
        <input type="number" name="erwartete_std" min="0" max="99" placeholder="00" class="zeit-teil" inputmode="numeric" />
        <span class="zeit-sep">:</span>
        <input type="number" name="erwartete_min" min="0" max="59" placeholder="00" class="zeit-teil" inputmode="numeric" />
      </div>
    </div>`;
}

// Eingabefeld für den geplanten Termin (Datum + Uhrzeit) einer Aufgabe/Layer.
// Getrennt von der "Erwarteten Zeit" oben — das ist die DAUER, das hier ist
// WANN es losgehen soll. Wird beim Anlegen mitgeschickt und erscheint dann
// im "Zeitstrahl"-Tab als Balken im 24-Stunden-Überblick.
function terminEingabeHtml() {
  return `
    <div class="termin-eingabe" title="Optional: Wann ist das geplant? Erscheint dann im Zeitstrahl-Tab.">
      <span class="zeit-label">📅 Termin</span>
      <input type="date" name="geplant_datum" class="select-dark" />
      <input type="time" name="geplant_zeit" class="select-dark" />
    </div>`;
}

// Eingabefeld für einen optionalen Link an einer Aufgabe (z. B. Bauplan,
// Referenzbild, Video-Tutorial). Wird beim Anlegen der Aufgabe mitgeschickt.
function linkEingabeHtml() {
  return `<input type="url" name="link" placeholder="🔗 Link (optional, z. B. Bauplan/Video)" class="link-eingabe" />`;
}

// Baut den "🔗 Link"-Button für eine Aufgabe, falls ein Link hinterlegt ist.
// Öffnet den Link in einem neuen Tab.
function taskLinkButtonHtml(t) {
  if (!t.link) return "";
  return `<a class="btn small secondary task-link-btn" href="${escapeHtml(t.link)}" target="_blank" rel="noopener noreferrer">🔗 Link</a>`;
}

// Kleine Info-Zeile mit dem geplanten Termin einer Aufgabe/Layer (falls gesetzt).
function terminBadgeHtml(item) {
  if (!item.geplant_datum) return "";
  return `<div class="task-meta">📅 ${escapeHtml(fmtTerminKurz(item.geplant_datum, item.geplant_zeit))}</div>`;
}

// Kleine Inline-Bearbeitung des geplanten Termins direkt an einer Aufgabe/Layer
// (nur für Berechtigte sichtbar). Speichert sofort bei Änderung, analog zur
// Blockliste-Schnellauswahl.
function terminQuickEditHtml(kind, id, datum, zeit) {
  const key = `${kind}-${id}`;
  return `<span class="termin-quickedit">
    <input type="date" class="select-dark select-inline" data-termin-datum="${key}" value="${datum || ""}" title="Geplantes Datum ändern" />
    <input type="time" class="select-dark select-inline" data-termin-zeit="${key}" value="${zeit || ""}" title="Geplante Uhrzeit ändern" />
  </span>`;
}

// Bindet die Termin-Schnellbearbeitung in einem gerade gerenderten Container ein.
// callback wird nach erfolgreichem Speichern aufgerufen (i. d. R. der jeweilige render*()).
function wireTerminControls(callback) {
  function speichern(kind, id) {
    const key = `${kind}-${id}`;
    const datumEl = document.querySelector(`[data-termin-datum="${key}"]`);
    const zeitEl = document.querySelector(`[data-termin-zeit="${key}"]`);
    if (!datumEl || !zeitEl) return;
    const endpoint = kind === "layer" ? `/stadion/layers/${id}/termin` : `/tasks/${id}/termin`;
    api(endpoint, { method: "POST", body: JSON.stringify({ datum: datumEl.value || "", zeit: zeitEl.value || "" }) })
      .then(() => callback())
      .catch((e) => alert(e.message));
  }
  document.querySelectorAll("[data-termin-datum]").forEach((el) => el.onchange = () => {
    const [kind, id] = el.dataset.terminDatum.split("-");
    speichern(kind, id);
  });
  document.querySelectorAll("[data-termin-zeit]").forEach((el) => el.onchange = () => {
    const [kind, id] = el.dataset.terminZeit.split("-");
    speichern(kind, id);
  });
}

// ---------- Neu-Zuweisen (Aufgaben & Layer) ----------
// Admin/Berechtigte können eine Aufgabe/Layer JEDERZEIT neu zuweisen — auch wenn
// bereits jemand zugewiesen ist oder sie freiwillig angenommen wurde. Erscheint
// als kleiner "🔄 Neu zuweisen"-Button, der einen Mehrfach-Auswahl-Picker aufklappt
// (mit den aktuell Zugewiesenen vorausgewählt) plus einen "Speichern"-Button.

function reassignPickerHtml(key, users, selectedIds) {
  return `
    <div class="assignment-picker" data-assignment-picker data-reassign-panel="${key}" hidden>
      <button type="button" class="assignment-trigger" data-assignment-trigger><span class="label">Spieler auswählen …</span><span class="count"></span>⌄</button>
      <div class="assignment-menu" data-assignment-menu hidden>
        ${users.map((u) => `<label class="assignment-option"><input type="checkbox" name="reassign_ids" value="${u.id}" data-name="${escapeHtml(u.vorname + " " + u.nachname)}" ${selectedIds.includes(u.id) ? "checked" : ""}><span>${escapeHtml(u.vorname)} ${escapeHtml(u.nachname)}<small>${escapeHtml(u.gamertag)}</small></span></label>`).join("")}
      </div>
    </div>`;
}

function reassignControlHtml(kind, id, users, selectedIds) {
  if (!users || !users.length) return "";
  const key = `${kind}-${id}`;
  return `
    <div class="reassign-box">
      <button type="button" class="ghost-btn tiny" data-reassign-toggle="${key}">🔄 Neu zuweisen</button>
      ${reassignPickerHtml(key, users, selectedIds)}
      <button type="button" class="btn small secondary" data-reassign-confirm="${key}" data-kind="${kind}" data-id="${id}" hidden>Speichern</button>
    </div>`;
}

// Bindet die Reassign-Buttons/-Picker in einem gerade gerenderten Container ein.
// callback wird nach erfolgreichem Neu-Zuweisen aufgerufen (i. d. R. der jeweilige render*()).
function wireReassignControls(callback) {
  document.querySelectorAll("[data-reassign-toggle]").forEach((b) => b.onclick = () => {
    const key = b.dataset.reassignToggle;
    const panel = document.querySelector(`[data-reassign-panel="${key}"]`);
    const confirmBtn = document.querySelector(`[data-reassign-confirm="${key}"]`);
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (confirmBtn) confirmBtn.hidden = panel.hidden;
  });
  document.querySelectorAll("[data-reassign-confirm]").forEach((b) => b.onclick = async () => {
    const key = b.dataset.reassignConfirm;
    const kind = b.dataset.kind;
    const id = b.dataset.id;
    const panel = document.querySelector(`[data-reassign-panel="${key}"]`);
    if (!panel) return;
    const ids = [...panel.querySelectorAll('input[name="reassign_ids"]:checked')].map((x) => Number(x.value)).filter(Boolean);
    try {
      const endpoint = kind === "layer" ? `/stadion/layers/${id}/zuweisen` : `/tasks/${id}/zuweisen`;
      await api(endpoint, { method: "POST", body: JSON.stringify({ user_ids: ids }) });
      callback();
    } catch (e) { alert(e.message); }
  });
}

// ---------- Blöcke: verknüpfte Litematica-Blockliste je Stadion-Layer ----------
// Holt (gecacht) die Liste aller Litematica-Block-Layer vom Server. Wird beim
// Anlegen einer Stadion-Layer als Auswahl angeboten und beim Anzeigen einer
// Layer genutzt, um den "🧱 Blöcke"-Button + die Schnellverknüpfung zu bauen.
async function loadBlockLayers() {
  if (state.blockLayers) return state.blockLayers;
  const { layers } = await api("/block-layers");
  state.blockLayers = layers;
  return layers;
}

// Auswahlfeld für die Block-Layer-Verknüpfung im "Neue Layer anlegen"-Formular.
function blockLayerSelectHtml(blockLayers, selectedNr) {
  return `
    <select name="blocklayer_nr" class="select-dark block-layer-select" title="Verknüpft diese Stadion-Layer mit einer Materialliste aus dem Bauplan">
      <option value="0">🧱 Blockliste verknüpfen (optional) …</option>
      ${blockLayers.map((bl) => `<option value="${bl.nr}" ${bl.nr === selectedNr ? "selected" : ""}>Litematica-Layer ${bl.nr} (${bl.total} Blöcke)</option>`).join("")}
    </select>`;
}

// Kleine Inline-Auswahl an einer bestehenden Stadion-Layer, mit der Admin/
// Berechtigte die verknüpfte Blockliste jederzeit ändern oder entfernen können.
function blockLinkQuickEditHtml(layerId, currentNr, blockLayers) {
  if (!blockLayers || !blockLayers.length) return "";
  return `
    <select class="select-dark select-inline" data-blocklink="${layerId}" title="Verknüpfte Blockliste ändern">
      <option value="0" ${!currentNr ? "selected" : ""}>🔗 Blockliste: keine</option>
      ${blockLayers.map((bl) => `<option value="${bl.nr}" ${bl.nr === currentNr ? "selected" : ""}>🔗 Layer ${bl.nr} (${bl.total})</option>`).join("")}
    </select>`;
}

// "🧱 Blöcke"-Button an einer Stadion-Layer — springt in den Blöcke-Tab und
// scrollt direkt zur verknüpften Litematica-Layer.
function blocksJumpButtonHtml(l) {
  if (!l.blocklayer_nr) return "";
  return `<button type="button" class="btn small secondary" data-goblocks="${l.blocklayer_nr}">🧱 Blöcke</button>`;
}

// Bindet die "🧱 Blöcke"-Buttons und die Blockliste-Schnellauswahl in einem
// gerade gerenderten Container ein.
function wireBlocksControls(callback) {
  document.querySelectorAll("[data-goblocks]").forEach((b) => b.onclick = () => {
    state.view = "bloecke";
    state.blockFocusNr = Number(b.dataset.goblocks);
    render();
  });
  document.querySelectorAll("[data-blocklink]").forEach((sel) => sel.onchange = async () => {
    try {
      await api(`/stadion/layers/${sel.dataset.blocklink}/blockliste`, {
        method: "POST",
        body: JSON.stringify({ blocklayer_nr: Number(sel.value) || 0 }),
      });
      if (callback) callback();
    } catch (e) { alert(e.message); }
  });
}

// ---------- Boot ----------

async function boot() {
  ensureAssignmentStyles();
  ensureBloeckeTab();
  ensureZeitstrahlTab();
  ensurePlanTab();
  removeRetiredTabs();
  ensureTabEmojis();
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.view = btn.dataset.view;
      if (state.view !== "bloecke") state.blockFocusNr = null;
      render();
    });
  });
  document.getElementById("logoutBtn").addEventListener("click", () => {
    setToken(null);
    state.me = null;
    if (state.notifHandle) clearInterval(state.notifHandle);
    render();
  });
  setupNotifUi();
  const initialNotifPanel = document.getElementById("notifPanel");
  if (initialNotifPanel) initialNotifPanel.hidden = true;
  state.notifOpen = false;

  if (!state.token) {
    renderAuth("login");
    return;
  }
  try {
    state.me = await api("/me");
    $topbar.hidden = false;
    applyTabVisibility();
    if (state.view === "gruppen" || state.view === "vorschlaege") state.view = "dashboard";
    render();
    startNotifPolling();
  } catch {
    setToken(null);
    renderAuth("login");
  }
}

// Fügt den "🧱 Blöcke"-Tab-Button dynamisch neben den bestehenden Tabs ein,
// falls er noch nicht im HTML vorhanden ist. Dadurch muss die index.html
// nicht angepasst werden — der Button entsteht automatisch beim Laden.
function ensureBloeckeTab() {
  if (!$tabs || document.querySelector('[data-view="bloecke"]')) return;
  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.view = "bloecke";
  btn.textContent = "🧱 Blöcke";
  $tabs.appendChild(btn);
}

// Fügt den "🕒 Zeitstrahl"-Tab-Button dynamisch neben den bestehenden Tabs ein,
// aus demselben Grund wie oben bei "🧱 Blöcke" — kein Eingriff in index.html nötig.
function ensureZeitstrahlTab() {
  if (!$tabs || document.querySelector('[data-view="zeitstrahl"]')) return;
  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.view = "zeitstrahl";
  btn.textContent = "🕒 Zeitstrahl";
  $tabs.appendChild(btn);
}

// Fügt den "📋 3-Tage-Plan"-Tab-Button dynamisch neben den bestehenden Tabs ein.
// Ersetzt den früheren PDF-Download auf der Startseite durch eine direkt
// lesbare, schön formatierte Übersicht.
function ensurePlanTab() {
  if (!$tabs || document.querySelector('[data-view="plan3tage"]')) return;
  const btn = document.createElement("button");
  btn.className = "tab";
  btn.dataset.view = "plan3tage";
  btn.textContent = "📋 3-Tage-Plan";
  $tabs.appendChild(btn);
}

// Entfernt die abgeschafften Tabs „Bau-Gruppen" und „Vorschläge" komplett aus
// der Tab-Leiste — unabhängig davon, ob sie fest in der index.html stehen
// oder früher dynamisch erzeugt wurden. Die zugehörigen render*()-Funktionen
// und Backend-Routen wurden ebenfalls entfernt.
function removeRetiredTabs() {
  document.querySelectorAll('[data-view="gruppen"], [data-view="vorschlaege"]').forEach((btn) => btn.remove());
}

// Beschriftungen (inkl. Emoji links vor dem Namen) für alle Abteilungen/Tabs.
// Wird einmalig beim Boot über die vorhandenen Tab-Buttons gelegt — so muss
// die index.html nicht angepasst werden, egal welchen Text sie ursprünglich hatte.
const TAB_LABELS = {
  dashboard: "🏠 Übersicht",
  aufgaben: "📋 Aufgaben",
  stadion: "🏟️ Stadion",
  bloecke: "🧱 Blöcke",
  zeitstrahl: "🕒 Zeitstrahl",
  shop: "🛒 Shop",
  kalender: "📅 Kalender",
  plan3tage: "📋 3-Tage-Plan",
  dateien: "📎 Dateien",
  zeitlog: "🕓 Zeitlog",
  leaderboard: "🏆 Rangliste",
  statistik: "📊 Statistik",
  kodex: "📜 Kodex",
  admin: "⚙️ Verwaltung",
};
function ensureTabEmojis() {
  document.querySelectorAll(".tab").forEach((btn) => {
    const label = TAB_LABELS[btn.dataset.view];
    if (label) btn.textContent = label;
  });
}

function applyTabVisibility() {
  const adminTab = document.querySelector('[data-view="admin"]');
  const statTab = document.querySelector('[data-view="statistik"]');
  if (adminTab) adminTab.hidden = !state.me.is_admin;
  if (statTab) statTab.hidden = !(state.me.is_admin || state.me.kann_statistiken_sehen);
}

// ---------- Benachrichtigungen ----------

function setupNotifUi() {
  const bell = document.getElementById("notifBell");
  const panel = document.getElementById("notifPanel");
  bell.onclick = async (e) => {
    e.stopPropagation();
    state.notifOpen = !state.notifOpen;
    panel.hidden = !state.notifOpen;
    if (state.notifOpen) await loadNotifPanel();
  };
  document.addEventListener("click", (e) => {
    if (state.notifOpen && !panel.contains(e.target) && e.target !== bell) {
      state.notifOpen = false;
      panel.hidden = true;
    }
  });
  document.getElementById("notifReadAll").onclick = async (e) => {
    e.stopPropagation();
    try { await api("/notifications/read-all", { method: "POST" }); await loadNotifPanel(); await pollNotifCount(); }
    catch (err) { /* ignore */ }
  };
}

async function loadNotifPanel() {
  const list = document.getElementById("notifList");
  list.innerHTML = `<div class="empty">Lade …</div>`;
  try {
    const { notifications } = await api("/notifications");
    list.innerHTML = notifications.length
      ? notifications.map((n) => `
        <div class="notif-item ${n.gelesen ? "" : "unread"}" data-notif="${n.id}">
          <div class="notif-title">${notifIcon(n.typ)} ${escapeHtml(n.titel)}</div>
          <div class="notif-text">${escapeHtml(n.text || "")}</div>
          <div class="notif-time">${fmtDate(n.erstellt_am)}</div>
        </div>`).join("")
      : `<div class="empty">Noch keine Benachrichtigungen.</div>`;
    list.querySelectorAll("[data-notif]").forEach((el) => el.onclick = async () => {
      try { await api(`/notifications/${el.dataset.notif}/read`, { method: "POST" }); el.classList.remove("unread"); pollNotifCount(); }
      catch {}
    });
  } catch {
    list.innerHTML = `<div class="empty">Konnte Benachrichtigungen nicht laden.</div>`;
  }
}

function notifIcon(typ) {
  return { AUFGABE_ZUGEWIESEN: "📋", AUFGABE_ERLEDIGT: "✅", LAYER_ZUGEWIESEN: "🏟️", LAYER_FERTIG: "🧱", SHOP_KAUF: "🛒", SHOP_ERLEDIGT: "🎁", EVENT_NEU: "📅", DATEI_NEU: "📎", PUNKTE_GUTSCHRIFT: "🪙" }[typ] || "🔔";
}

function updateNotifBadge(count) {
  const badge = document.getElementById("notifBadge");
  if (count > 0) { badge.hidden = false; badge.textContent = count > 99 ? "99+" : count; }
  else { badge.hidden = true; }
}

async function pollNotifCount() {
  try {
    const { unread } = await api("/notifications/count");
    updateNotifBadge(unread);
  } catch { /* offline etc. */ }
}

function startNotifPolling() {
  if (state.notifHandle) clearInterval(state.notifHandle);
  pollNotifCount();
  state.notifHandle = setInterval(async () => {
    try {
      const { notifications } = await api("/notifications");
      const newest = notifications[0];
      if (newest && newest.id > state.lastNotifId) {
        if (state.lastNotifId !== 0) {
          const frisch = notifications.filter((n) => n.id > state.lastNotifId);
          frisch.slice().reverse().forEach(fireBrowserNotification);
        }
        state.lastNotifId = newest.id;
      }
      updateNotifBadge(notifications.filter((n) => !n.gelesen).length);
      if (state.notifOpen) loadNotifPanel();
    } catch { /* offline etc. */ }
  }, 20000);
}

function checkBrowserNotifPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default" && !state.notifPermAsked) {
    state.notifPermAsked = true;
    Notification.requestPermission();
  }
}

function fireBrowserNotification(n) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const notif = new Notification("🧱 " + n.titel, { body: n.text || "", tag: "bb-" + n.id });
    notif.onclick = () => { window.focus(); };
  } catch { /* Browser blockiert evtl. */ }
}

// ---------- Auth-Ansichten ----------

function renderAuth(mode) {
  $topbar.hidden = true;
  if (state.tickHandle) clearInterval(state.tickHandle);
  if (state.workTimerHandle) clearInterval(state.workTimerHandle);
  if (state.notifHandle) clearInterval(state.notifHandle);
  if (state.zeitstrahlHandle) clearInterval(state.zeitstrahlHandle);

  if (mode === "login") {
    $app.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="auth-logo"><div class="auth-logo-plaque"><img src="logo-full.png" alt="Beton-Buben GmbH" /></div></div>
          <h1>Beton-Buben</h1>
          <div class="subtitle">Stadionbau · Melde dich mit deinem Minecraft-Konto an</div>
          <form id="loginForm">
            <label>Minecraft Gamertag</label>
            <input type="text" name="gamertag" autocomplete="username" required />
            <label>Passwort</label>
            <input type="password" name="passwort" autocomplete="current-password" required />
            <button class="btn" type="submit">Anmelden</button>
          </form>
          <div id="authErr"></div>
          <a href="#" class="switch-link" id="toRegister">Noch kein Konto? Jetzt registrieren</a>
        </div>
      </div>`;
    document.getElementById("toRegister").onclick = (e) => { e.preventDefault(); renderAuth("register"); };
    document.getElementById("loginForm").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const data = await api("/login", { method: "POST", body: JSON.stringify({ gamertag: f.get("gamertag"), passwort: f.get("passwort") }) });
        setToken(data.token);
        await boot();
      } catch (err) {
        document.getElementById("authErr").innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    };
  } else {
    $app.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="auth-logo"><div class="auth-logo-plaque"><img src="logo-full.png" alt="Beton-Buben GmbH" /></div></div>
          <h1>Neues Konto</h1>
          <div class="subtitle">Werde Teil der Beton-Buben Bau-Crew</div>
          <form id="regForm">
            <label>Vorname</label>
            <input type="text" name="vorname" required />
            <label>Nachname</label>
            <input type="text" name="nachname" required />
            <label>Minecraft Gamertag</label>
            <input type="text" name="gamertag" required />
            <label>Passwort</label>
            <input type="password" name="passwort" minlength="4" required />
            <button class="btn" type="submit">Konto erstellen</button>
          </form>
          <div id="authErr"></div>
          <a href="#" class="switch-link" id="toLogin">Schon registriert? Zur Anmeldung</a>
        </div>
      </div>`;
    document.getElementById("toLogin").onclick = (e) => { e.preventDefault(); renderAuth("login"); };
    document.getElementById("regForm").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const data = await api("/register", {
          method: "POST",
          body: JSON.stringify({
            vorname: f.get("vorname"), nachname: f.get("nachname"),
            gamertag: f.get("gamertag"), passwort: f.get("passwort"),
          }),
        });
        if (data.pending) {
          $app.innerHTML = `
            <div class="auth-wrap">
              <div class="auth-card">
                <div class="auth-logo">⏳</div>
                <h1>Fast geschafft</h1>
                <div class="subtitle">${escapeHtml(data.message)}</div>
                <a href="#" class="switch-link" id="backToLogin">Zurück zur Anmeldung</a>
              </div>
            </div>`;
          document.getElementById("backToLogin").onclick = (e2) => { e2.preventDefault(); renderAuth("login"); };
          return;
        }
        setToken(data.token);
        await boot();

      } catch (err) {
        document.getElementById("authErr").innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      }
    };
  }
}

// ---------- Haupt-Render ----------

function render() {
  if (!state.me) { renderAuth("login"); return; }
  $whoName.textContent = `${state.me.vorname} ${state.me.gamertag !== state.me.vorname ? "· " + state.me.gamertag : ""}`;
  document.getElementById("whoAvatar").innerHTML = avatarHtml(state.me.avatar, 26);
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
  if (state.tickHandle) clearInterval(state.tickHandle);
  if (state.workTimerHandle) clearInterval(state.workTimerHandle);
  if (state.zeitstrahlHandle) clearInterval(state.zeitstrahlHandle);

  const views = {
    dashboard: renderDashboard,
    aufgaben: renderAufgaben,
    stadion: renderStadion,
    bloecke: renderBloecke,
    zeitstrahl: renderZeitstrahl,
    shop: renderShop,
    kalender: renderKalender,
    plan3tage: renderPlan3Tage,
    dateien: renderDateien,
    zeitlog: renderZeitlog,
    leaderboard: renderLeaderboard,
    statistik: renderStatistik,
    kodex: renderKodex,
    admin: renderAdmin,
  };
  (views[state.view] || renderDashboard)();
}

// ---------- Schematic-Platzierung (Dashboard-Hinweis) ----------
// Zeigt allen an, bei welcher Koordinate die Schematic platziert werden soll.
// Nur der Admin kann die drei Felder (X/Y/Z) bearbeiten und speichern.
function schematicPanelHtml(coords, isAdmin) {
  const hatKoords = coords && coords.x !== null && coords.y !== null && coords.z !== null;
  if (isAdmin) {
    return `
    <div class="panel schematic-panel">
      <h2>🧭 Schematic-Platzierung</h2>
      <div class="subtitle" style="margin-bottom:12px;">Trage hier ein, bei welcher Koordinate die Schematic im Bauplan platziert werden soll — sichtbar für die ganze Crew.</div>
      <form id="schematicForm" class="task-form">
        <input type="number" step="1" name="x" placeholder="z. B. 108" class="num-input" value="${coords && coords.x !== null ? coords.x : ""}" />
        <span class="zeit-label">X</span>
        <input type="number" step="1" name="y" placeholder="z. B. 40" class="num-input" value="${coords && coords.y !== null ? coords.y : ""}" />
        <span class="zeit-label">Y</span>
        <input type="number" step="1" name="z" placeholder="z. B. 310" class="num-input" value="${coords && coords.z !== null ? coords.z : ""}" />
        <span class="zeit-label">Z</span>
        <button class="btn small" type="submit">Speichern</button>
      </form>
    </div>`;
  }
  return `
    <div class="panel schematic-panel">
      <h2>🧭 Schematic-Platzierung</h2>
      <div class="subtitle">${hatKoords
        ? `Die Schematic soll bei Koordinate <strong>X: ${coords.x}</strong>, <strong>Y: ${coords.y}</strong>, <strong>Z: ${coords.z}</strong> platziert werden.`
        : "Es wurde noch keine Koordinate für die Schematic hinterlegt — frag einen Admin."}</div>
    </div>`;
}

// Kompakte Kennzahlen-Leiste (Punkte / Gesamtzeit / Zeit heute) — bewusst
// schmal gehalten, damit sie zwar weit oben sichtbar ist, aber kaum Platz
// frisst (ersetzt die frühere große 3-Kachel-Reihe weiter unten).
function miniStatsRowHtml(me) {
  return `
    <div class="mini-stats-row">
      <span class="mini-stat">🕓 Heute <strong>${fmtStd(me.heute_std)}</strong> Std.</span>
      <span class="mini-stat">📊 Gesamt <strong>${fmtStd(me.gesamt_std)}</strong> Std.</span>
      <span class="mini-stat">🪙 Punkte <strong>${me.punkte}</strong></span>
    </div>`;
}

// ---------- Dashboard ----------

// silent=true wird für den automatischen 20-Sekunden-Refresh genutzt (wenn im
// heutigen Zeitstrahl-Mini-Panel gerade etwas läuft, siehe unten). Dabei wird
// NICHT zuerst der "Lade Baustelle …"-Platzhalter angezeigt — genau das war
// der Grund für das kurze Aufblitzen/Flackern der Seite alle paar Sekunden.
//
// Reihenfolge der Panels wurde bewusst so gewählt, dass auf einem normalen
// Desktop-Monitor (ohne Scrollen) direkt sichtbar sind: Mini-Statistik-Leiste,
// offene Aufgaben/Layer + On/Off-Schalter, sowie Zeitstrahl + Baufortschritt.
// "Meine Layer in Arbeit" ist jetzt Teil derselben Karte wie "Aufgaben in
// Arbeit" — sobald dir eine Layer zugewiesen wird, erscheint sie dort mit.
async function renderDashboard(opts = {}) {
  const silent = opts.silent === true;

  // Laufende Intervalle IMMER zuerst stoppen. Der On/Off-Schalter und die
  // Start/Pause/Fertig-Buttons rufen renderDashboard() direkt auf (nicht über
  // render()), daher lief der alte Uhr-Timer sonst einfach weiter mit —
  // mehrere Intervalle gleichzeitig ließen die Anzeige durcheinanderspringen.
  if (state.tickHandle) clearInterval(state.tickHandle);
  if (state.workTimerHandle) clearInterval(state.workTimerHandle);

  if (!silent) $app.innerHTML = `<div class="empty">Lade Baustelle …</div>`;
  const me = await api("/me");
  state.me = me;
  applyTabVisibility();
  document.getElementById("whoAvatar").innerHTML = avatarHtml(me.avatar, 26);
  const [{ tasks }, { layers }, schematic, { eintraege }] = await Promise.all([
    api("/tasks"),
    api("/stadion/layers"),
    api("/schematic"),
    api("/kalender"),
  ]);
  const overviewUsers = [];
  const meineAufgaben = tasks.filter((t) => (t.zustaendig_user_id === me.id || (t.assignees || []).some((a) => a.id === me.id)) && t.status !== "ERLEDIGT").slice(0, 4);
  const meineLayer = layers.filter((l) => (l.zustaendig_user_id === me.id || (l.assignees || []).some((a) => a.id === me.id)) && l.status !== "FERTIG").slice(0, 4);
  const fertigeLayer = layers.filter((l) => l.status === "FERTIG").length;
  const layerGesamt = layers.length;
  const layerProzent = layerGesamt ? Math.round((fertigeLayer / layerGesamt) * 100) : 0;
  const heutigDatum = todayStrLocal();
  const heutigeItems = buildZeitstrahlItems(tasks, layers, eintraege, heutigDatum);

  $app.innerHTML = `
    <h1>Willkommen, ${escapeHtml(me.vorname)}</h1>
    <div class="subtitle">Deine Online-Zeit rechts, deine Aufgaben links. Alles landet in der Rangliste.
      ${me.rang ? ` · Rang: <span class="rank-chip" style="border-color:${me.rang.farbe};color:${me.rang.farbe}">${escapeHtml(me.rang.name)}</span>` : ""}</div>

    ${miniStatsRowHtml(me)}

    <div class="grid grid-2">
      <div class="panel">
        <h2>📋 Aufgaben & Layer in Arbeit</h2>
        ${(meineAufgaben.length || meineLayer.length)
          ? `<ul class="task-list">${meineAufgaben.map(dashboardTaskHtml).join("")}${meineLayer.map(dashboardLayerHtml).join("")}</ul>`
          : `<div class="empty">Keine offenen Aufgaben oder Layer — schau bei „Aufgaben" oder „Stadion" vorbei.</div>`}
      </div>

      <div class="panel switch-panel">
        <div class="power-caption">Online-Zeit</div>
        <div id="powerSwitch" class="power-switch ${me.online ? "on" : ""}">${me.online ? "ON" : "OFF"}</div>
        <div class="power-readout" id="liveClock">${me.online ? fmtClock(Date.now() - new Date(me.online_seit)) : "00:00:00"}</div>
        <div class="power-caption">${me.online ? "läuft seit " + fmtDate(me.online_seit) : "Klicke zum Starten"}</div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="panel">
        <div class="toolbar" style="margin-bottom:2px;">
          <h2 style="margin:0;">🕒 Heutiger Zeitstrahl</h2>
          <button type="button" class="btn small secondary" data-goto-zeitstrahl>Ganzer Zeitstrahl ▶</button>
        </div>
        <div class="subtitle" style="margin:6px 0 0;">${fmtDatumKurz(heutigDatum)}</div>
        ${zeitstrahlTimelineHtml(heutigeItems, true)}
      </div>

      <div class="panel overview-progress-panel">
        <h2>🏗️ Baufortschritt</h2>
        <div class="stadium-progress-wrap">
          <div class="stadium-progress-count">${fertigeLayer} von ${layerGesamt} Layern fertig</div>
          <div class="stadium-progress"><div class="stadium-progress-fill" style="width:${layerProzent}%"></div></div>
          <div class="stadium-progress-percent">${layerProzent}%</div>
        </div>
      </div>
    </div>

    ${schematicPanelHtml(schematic, me.is_admin)}

    <div class="panel">
      ${me.badge.current ? `<div class="badge-row"><span class="badge-icon">${me.badge.current.icon}</span><div><div class="badge-name">${me.badge.current.name}</div>${me.badge.next ? `<div class="badge-next">Nächstes Ziel: ${me.badge.next.icon} ${me.badge.next.name} bei ${me.badge.next.std} Std.</div>` : `<div class="badge-next">Höchste Stufe erreicht!</div>`}</div></div>`
        : `<div class="badge-row"><span class="badge-icon">🚧</span><div><div class="badge-name">Noch kein Abzeichen</div><div class="badge-next">Erstes Ziel: 🧱 Grundstein gelegt bei 1 Std.</div></div></div>`}
    </div>

    <div class="panel">
      <h2>👷 Spielerübersicht</h2>
      <div class="table-wrap">
        <table><thead><tr><th>Spieler</th><th>Spielzeit</th><th>Aufgaben abgeschlossen</th></tr></thead>
        <tbody>${overviewUsers.map((u) => `<tr><td>${escapeHtml(u.vorname)} ${escapeHtml(u.nachname)}</td><td>${fmtStd(u.gesamt_std)}</td><td>${u.aufgaben_erledigt}</td></tr>`).join("")}</tbody></table>
      </div>
    </div>

    <div class="panel">
      <h2>Dein Avatar</h2>
      <div class="subtitle" style="margin-bottom:12px;">Standard ist dein Minecraft-Kopf — du kannst ihn hier durch ein Emoji ersetzen.</div>
      <div class="avatar-picker">
        <button class="avatar-opt ${!me.avatar || me.avatar.typ !== 'emoji' ? 'selected' : ''}" data-avatar="">${avatarHtml({ typ: "kopf", wert: `https://mc-heads.net/avatar/${encodeURIComponent(me.gamertag)}/48` }, 40)}</button>
        ${EMOJI_CHOICES.map((e) => `<button class="avatar-opt ${me.avatar && me.avatar.wert === e ? 'selected' : ''}" data-avatar="${e}">${avatarHtml({ typ: "emoji", wert: e }, 40)}</button>`).join("")}
      </div>
    </div>

    <div class="panel">
      <h2>📐 Baupläne</h2>
      <div class="subtitle" style="margin-bottom:12px;">Die aktuellen Baupläne zum Download bzw. Nachlesen.</div>
      <ul class="task-list">
        <li class="task-item">
          <span class="titel">🏟️ Bauplan für Stadion<div class="task-meta">Litematica-Datei (.litematic)</div></span>
          <a class="btn small secondary" href="/plaene/unnamed.litematic" download>⬇ Download</a>
        </li>
        <li class="task-item">
          <span class="titel">📋 Plan für die ersten drei Tage<div class="task-meta">Jetzt direkt hier im Tab statt als PDF</div></span>
          <button type="button" class="btn small secondary" data-goto-plan>Ansehen</button>
        </li>
      </ul>
    </div>
  `;

  document.getElementById("powerSwitch").onclick = async () => {
    try {
      await api("/session/toggle", { method: "POST" });
      renderDashboard();
    } catch (e) { alert(e.message); }
  };

  document.querySelectorAll("[data-avatar]").forEach((b) => b.onclick = async () => {
    try { await api("/me/avatar", { method: "POST", body: JSON.stringify({ avatar: b.dataset.avatar }) }); renderDashboard(); }
    catch (e) { alert(e.message); }
  });

  const schematicForm = document.getElementById("schematicForm");
  if (schematicForm) {
    schematicForm.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api("/schematic", { method: "POST", body: JSON.stringify({ x: f.get("x"), y: f.get("y"), z: f.get("z") }) });
        renderDashboard();
      } catch (err) { alert(err.message); }
    };
  }

  document.querySelectorAll("[data-goto-plan]").forEach((b) => b.onclick = () => {
    state.view = "plan3tage";
    render();
  });

  document.querySelectorAll("[data-goto-zeitstrahl]").forEach((b) => b.onclick = () => {
    state.zeitstrahlDatum = heutigDatum;
    state.view = "zeitstrahl";
    render();
  });

  // Aufgaben direkt aus der Übersicht starten/pausieren/fortsetzen/abschließen
  document.querySelectorAll("[data-start]").forEach((b) => b.onclick = async () => {
    try { await api(`/tasks/${b.dataset.start}/start`, { method: "POST" }); renderDashboard(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-pause]").forEach((b) => b.onclick = async () => {
    try { await api(`/tasks/${b.dataset.pause}/pause`, { method: "POST" }); renderDashboard(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-resume]").forEach((b) => b.onclick = async () => {
    try { await api(`/tasks/${b.dataset.resume}/resume`, { method: "POST" }); renderDashboard(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-complete]").forEach((b) => b.onclick = async () => {
    try { await api(`/tasks/${b.dataset.complete}/complete`, { method: "POST" }); renderDashboard(); }
    catch (e) { alert(e.message); }
  });

  // Dasselbe für Stadion-Layer direkt aus der Übersicht
  document.querySelectorAll("[data-lstart]").forEach((b) => b.onclick = async () => {
    try { await api(`/stadion/layers/${b.dataset.lstart}/start`, { method: "POST" }); renderDashboard(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-lpause]").forEach((b) => b.onclick = async () => {
    try { await api(`/stadion/layers/${b.dataset.lpause}/pause`, { method: "POST" }); renderDashboard(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-lresume]").forEach((b) => b.onclick = async () => {
    try { await api(`/stadion/layers/${b.dataset.lresume}/resume`, { method: "POST" }); renderDashboard(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-lcomplete]").forEach((b) => b.onclick = async () => {
    try { await api(`/stadion/layers/${b.dataset.lcomplete}/complete`, { method: "POST" }); renderDashboard(); }
    catch (e) { alert(e.message); }
  });

  // "🧱 Blöcke"-Buttons auf dem Dashboard verlinken in den Blöcke-Tab
  wireBlocksControls();

  if (me.online) {
    const since = new Date(me.online_seit).getTime();
    state.tickHandle = setInterval(() => {
      const el = document.getElementById("liveClock");
      if (el) el.textContent = fmtClock(Date.now() - since);
    }, 1000);
  }

  // Live-Timer neben laufenden Aufgaben/Layern (⏱ läuft seit Start)
  startWorkTimerTicker();

  // Läuft gerade ein Termin im heutigen Zeitstrahl-Mini-Panel, wird das
  // Dashboard alle 20 Sekunden neu geladen, damit überzogene Balken live
  // weiterwachsen — jetzt im "silent"-Modus, ohne den Lade-Zwischenschritt,
  // damit die Seite dabei nicht mehr kurz aufblitzt/flackert.
  const hatLaufende = heutigeItems.some((it) => it.status === "LAEUFT");
  if (hatLaufende) {
    state.zeitstrahlHandle = setInterval(() => {
      if (state.view === "dashboard") renderDashboard({ silent: true });
    }, 20000);
  }
}

document.querySelectorAll("[data-dashboard-task]").forEach((el) => el.onclick = () => { state.view = "aufgaben"; render(); });

const STATUS_LABEL = { OFFEN: "OFFEN", LAEUFT: "LÄUFT", PAUSIERT: "PAUSE", ERLEDIGT: "ERLEDIGT", FERTIG: "FERTIG" };

// Baut die Start/Pause/Weiter/Fertig-Buttons für eine Aufgabe.
// includeDelete=false für Karten außerhalb der Aufgaben-Verwaltung (z. B. Dashboard).
function taskActionsHtml(t, { includeDelete = false } = {}) {
  let actions = "";
  if (t.status === "OFFEN") actions = `<button class="btn small" data-start="${t.id}">Start</button>`;
  else if (t.status === "LAEUFT") actions = `<button class="btn small secondary" data-pause="${t.id}">⏸ Pause</button> <button class="btn small secondary" data-complete="${t.id}">Fertig ✓</button>`;
  else if (t.status === "PAUSIERT") actions = `<button class="btn small secondary" data-resume="${t.id}">▶ Weiter</button> <button class="btn small secondary" data-complete="${t.id}">Fertig ✓</button>`;
  if (includeDelete) actions += ` <button class="btn small secondary" data-delete="${t.id}">🗑</button>`;
  return actions;
}

// Dasselbe für Stadion-Layer.
function layerActionsHtml(l, { includeDelete = false } = {}) {
  let actions = "";
  if (l.status === "OFFEN") actions = `<button class="btn small" data-lstart="${l.id}">Start</button>`;
  else if (l.status === "LAEUFT") actions = `<button class="btn small secondary" data-lpause="${l.id}">⏸ Pause</button> <button class="btn small secondary" data-lcomplete="${l.id}">Fertig ✓</button>`;
  else if (l.status === "PAUSIERT") actions = `<button class="btn small secondary" data-lresume="${l.id}">▶ Weiter</button> <button class="btn small secondary" data-lcomplete="${l.id}">Fertig ✓</button>`;
  if (includeDelete) actions += ` <button class="btn small secondary" data-ldelete="${l.id}">🗑</button>`;
  return actions;
}

// Live-Timer-Chip für eine Aufgabe. Hat die Aufgabe eine erwartete Zeit
// (erwartete_sekunden > 0), wird ein Countdown gezeigt (zählt runter,
// pausiert exakt beim aktuellen Stand, geht bei Überschreitung ins Minus).
// Ohne erwartete Zeit bleibt es bei der einfachen Stoppuhr wie bisher.
// Noch nicht gestartete Aufgaben mit gesetzter erwarteter Zeit zeigen die
// Zieldauer statisch als HH:MM an (⏳-Badge statt ⏱-Countdown).
function taskTimerHtml(t) {
  const erwartet = t.erwartete_sekunden || 0;
  if (t.status === "LAEUFT" && t.start_zeit) {
    if (erwartet > 0) {
      return `<span class="work-timer" data-timer-start="${t.start_zeit}" data-timer-verbraucht="${t.verbrauchte_sekunden || 0}" data-timer-erwartet="${erwartet}">⏱ ${fmtCountdown(erwartet - (t.verbrauchte_sekunden || 0))}</span>`;
    }
    return `<span class="work-timer" data-timer-start="${t.start_zeit}">⏱ 00:00:00</span>`;
  }
  if (t.status === "PAUSIERT" && erwartet > 0) {
    return `<span class="work-timer paused">⏸ ${fmtCountdown(erwartet - (t.verbrauchte_sekunden || 0))}</span>`;
  }
  if (t.status === "OFFEN" && erwartet > 0) {
    return `<span class="work-timer paused">⏳ ${fmtHM(erwartet)}</span>`;
  }
  return "";
}
// Live-Timer-Chip für einen Stadion-Layer — funktioniert jetzt genau wie bei
// Aufgaben mit Countdown ab der erwarteten Zeit (⏳ bevor gestartet, ⏱
// Countdown während LAEUFT, ⏸ eingefroren während PAUSIERT).
function layerTimerHtml(l) {
  const erwartet = l.erwartete_sekunden || 0;
  if (l.status === "LAEUFT" && l.start_zeit) {
    if (erwartet > 0) {
      return `<span class="work-timer" data-timer-start="${l.start_zeit}" data-timer-verbraucht="${l.verbrauchte_sekunden || 0}" data-timer-erwartet="${erwartet}">⏱ ${fmtCountdown(erwartet - (l.verbrauchte_sekunden || 0))}</span>`;
    }
    return `<span class="work-timer" data-timer-start="${l.start_zeit}">⏱ 00:00:00</span>`;
  }
  if (l.status === "PAUSIERT" && erwartet > 0) {
    return `<span class="work-timer paused">⏸ ${fmtCountdown(erwartet - (l.verbrauchte_sekunden || 0))}</span>`;
  }
  if (l.status === "OFFEN" && erwartet > 0) {
    return `<span class="work-timer paused">⏳ ${fmtHM(erwartet)}</span>`;
  }
  return "";
}

// Aufgaben-Karte für die Dashboard-Übersicht: Start/Pause/Fertig direkt anklickbar,
// inklusive laufendem Timer — ohne Löschen-Button (der bleibt der Aufgabenverwaltung vorbehalten).
function dashboardTaskHtml(t) {
  const cls = t.status === "ERLEDIGT" ? "done" : "";
  const names = (t.assignees || []).map((a) => a.vorname + " " + a.nachname).join(" / ") || t.zustaendig_name || "";
  return `<li class="task-item ${cls}">
    <span class="titel">${escapeHtml(t.titel)}${t.punkte ? `<span class="punkte-tag">🪙 ${t.punkte}</span>` : ""}${names ? `<div class="task-meta">👷 ${escapeHtml(names)}</div>` : ""}${terminBadgeHtml(t)}</span>
    <span class="status-pill ${t.status}">${STATUS_LABEL[t.status] || t.status}</span>
    ${taskTimerHtml(t)}
    ${taskLinkButtonHtml(t)}
    ${taskActionsHtml(t)}
  </li>`;
}

// Layer-Karte für die Dashboard-Übersicht, analog zu dashboardTaskHtml.
function dashboardLayerHtml(l) {
  const cls = l.status === "FERTIG" ? "done" : "";
  const names = (l.assignees || []).map((a) => a.vorname + " " + a.nachname).join(" / ") || l.zustaendig_name || "";
  return `<li class="task-item ${cls}">
    <span class="titel">L${l.layer_nr} · ${escapeHtml(l.name)}${l.punkte ? `<span class="punkte-tag">🪙 ${l.punkte}</span>` : ""}${names ? `<div class="task-meta">👷 ${escapeHtml(names)}</div>` : ""}${terminBadgeHtml(l)}</span>
    <span class="status-pill ${l.status}">${STATUS_LABEL[l.status] || l.status}</span>
    ${layerTimerHtml(l)}
    ${blocksJumpButtonHtml(l)}
    ${layerActionsHtml(l)}
  </li>`;
}

// ---------- Aufgaben ----------

async function renderAufgaben() {
  $app.innerHTML = `<div class="empty">Lade Aufgabenliste …</div>`;
  const canAssign = state.me.is_admin || state.me.kann_aufgaben_zuweisen;
  const [{ tasks }, spieler] = await Promise.all([
    api("/tasks"),
    canAssign ? api("/users/active") : Promise.resolve({ users: [] }),
  ]);

  $app.innerHTML = `
    <h1>Aufgaben · Baustelle</h1>
    <div class="subtitle">Eintragen → Starten → Häkchen setzen, wenn fertig. Pause ist jederzeit möglich. Offene Aufgaben können sich auch andere freiwillig schnappen.</div>

    <div class="panel">
      <form id="taskForm" class="task-form">
        <input type="text" name="titel" placeholder="z. B. Tribüne Nordkurve verkleiden" required />
        <select name="prioritaet" class="select-dark">
          <option value="NIEDRIG">Niedrig</option>
          <option value="NORMAL" selected>Normal</option>
          <option value="HOCH">Hoch</option>
        </select>
        ${zeitEingabeHtml()}
        ${terminEingabeHtml()}
        ${linkEingabeHtml()}
        ${canAssign ? `
        <div class="assignment-box" style="flex:1;min-width:260px;">
          <div class="assignment-mode">
            <button type="button" class="active" data-assignment-mode="single">👤 Eine Person</button>
            <button type="button" data-assignment-mode="multiple">👥 Mehrere Personen</button>
          </div>
          <select name="zustaendig_user_id" class="select-dark" data-single-assignment>
            <option value="">— niemand zuweisen —</option>
            ${spieler.users.map((u) => `<option value="${u.id}">${escapeHtml(u.vorname)} ${escapeHtml(u.nachname)}</option>`).join("")}
          </select>
          <div class="assignment-picker hidden" data-multi-assignment data-assignment-picker>
            <button type="button" class="assignment-trigger" data-assignment-trigger><span class="label">Spieler auswählen …</span><span class="count"></span>⌄</button>
            <div class="assignment-menu" data-assignment-menu hidden>
              ${spieler.users.map((u) => `<label class="assignment-option"><input type="checkbox" name="zustaendig_user_ids" value="${u.id}" data-name="${escapeHtml(u.vorname + " " + u.nachname)}"><span>${escapeHtml(u.vorname)} ${escapeHtml(u.nachname)}<small>${escapeHtml(u.gamertag)}</small></span></label>`).join("")}
            </div>
          </div>
        </div>` : ""}
        ${state.me.is_admin ? `<input type="number" name="punkte" min="0" placeholder="Punkte" class="num-input" style="width:90px;height:40px;" title="Wie viele Punkte gibt diese Aufgabe? (nur Admin)" />` : ""}
        <button class="btn small" type="submit">Aufgabe anlegen</button>
      </form>
    </div>

    <div class="panel">
      ${tasks.length ? `<ul class="task-list">${tasks.map((t) => fullTaskHtml(t, spieler.users, canAssign)).join("")}</ul>` : `<div class="empty">Noch keine Aufgaben. Leg die erste an!</div>`}
    </div>
  `;

  document.getElementById("taskForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("/tasks", {
        method: "POST",
        body: JSON.stringify({
          titel: f.get("titel"),
          prioritaet: f.get("prioritaet"),
          erwartete_minuten: getErwarteteMinuten(e.target),
          link: f.get("link") || "",
          datum: f.get("geplant_datum") || "",
          zeit: f.get("geplant_zeit") || "",
          zustaendig_user_ids: (() => {
            const multi = getSelectedAssignmentIds(e.target);
            const single = f.get("zustaendig_user_id");
            return multi.length ? multi : (single ? [Number(single)] : []);
          })(),
          punkte: f.get("punkte") ? Number(f.get("punkte")) : 0,
        }),
      });
      renderAufgaben();
    } catch (err) { alert(err.message); }
  };

  document.querySelectorAll("[data-assignment-mode]").forEach((b) => b.onclick = () => {
    setAssignmentMode(document.getElementById("taskForm"), b.dataset.assignmentMode === "multiple");
  });
  setupAssignmentPicker(document.getElementById("taskForm"));

  document.querySelectorAll("[data-accept]").forEach((b) => b.onclick = async () => {
    try { await api(`/tasks/${b.dataset.accept}/annehmen`, { method: "POST" }); renderAufgaben(); }
    catch (e) { alert(e.message); }
  });

  document.querySelectorAll("[data-start]").forEach((b) => b.onclick = async () => {
    try { await api(`/tasks/${b.dataset.start}/start`, { method: "POST" }); renderAufgaben(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-pause]").forEach((b) => b.onclick = async () => {
    try { await api(`/tasks/${b.dataset.pause}/pause`, { method: "POST" }); renderAufgaben(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-resume]").forEach((b) => b.onclick = async () => {
    try { await api(`/tasks/${b.dataset.resume}/resume`, { method: "POST" }); renderAufgaben(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-complete]").forEach((b) => b.onclick = async () => {
    try { await api(`/tasks/${b.dataset.complete}/complete`, { method: "POST" }); renderAufgaben(); }
    catch (e) { alert(e.message); }
  });
  startWorkTimerTicker();

  document.querySelectorAll("[data-delete]").forEach((b) => b.onclick = async () => {
    if (!confirm("Aufgabe wirklich löschen?")) return;
    try { await api(`/tasks/${b.dataset.delete}`, { method: "DELETE" }); renderAufgaben(); }
    catch (e) { alert(e.message); }
  });

  // Neu-Zuweisen-Steuerelemente (Picker öffnen/schließen + Speichern)
  wireReassignControls(renderAufgaben);
  setupAssignmentPicker(document);
  // Termin-Schnellbearbeitung (Datum/Uhrzeit direkt an der Aufgabe ändern)
  wireTerminControls(renderAufgaben);
}

function fullTaskHtml(t, spielerUsers = [], canAssign = false) {
  const cls = t.status === "ERLEDIGT" ? "done" : "";
  const actions = taskActionsHtml(t, { includeDelete: true });
  const assignees = t.assignees || [];
  const names = assignees.length ? assignees.map((a) => `${a.vorname} ${a.nachname} (${a.anteil || 100}%)`).join(" / ") : (t.zustaendig_name || "");
  const splitHint = assignees.length > 1 && t.punkte ? `<div class="task-meta">🪙 Punkte werden gleichmäßig auf ${assignees.length} Spieler verteilt.</div>` : "";
  // Offene Aufgaben können von jedem, der noch nicht zugewiesen ist, freiwillig angenommen werden —
  // egal ob unzugewiesen oder bereits jemand anderem zugewiesen.
  const kannAnnehmen = t.status === "OFFEN" && !assignees.some((a) => a.id === state.me.id);
  const acceptBtn = kannAnnehmen ? `<button class="btn small" data-accept="${t.id}">🙋 Annehmen</button>` : "";
  // Admin/Berechtigte können jederzeit neu zuweisen — auch nach Zuweisung oder freiwilliger Annahme.
  const reassignBtn = canAssign ? reassignControlHtml("task", t.id, spielerUsers, assignees.map((a) => a.id)) : "";
  // Admin/Berechtigte können den geplanten Termin jederzeit direkt hier ändern.
  const terminEdit = canAssign ? terminQuickEditHtml("task", t.id, t.geplant_datum, t.geplant_zeit) : "";
  return `<li class="task-item ${cls}">
    <span class="titel">${escapeHtml(t.titel)}${t.punkte ? `<span class="punkte-tag">🪙 ${t.punkte}</span>` : ""}${names ? `<div class="task-meta">👷 ${escapeHtml(names)}</div>` : ""}${splitHint}${terminBadgeHtml(t)}</span>
    <span class="status-pill ${t.status}">${STATUS_LABEL[t.status] || t.status}</span>
    ${taskTimerHtml(t)}
    ${taskLinkButtonHtml(t)}
    ${acceptBtn}
    ${actions}
    ${reassignBtn}
    ${terminEdit}
  </li>`;
}

// ---------- Stadion-Bau ----------

function stadiumVisualHtml(layers) {
  if (!layers.length) return `<div class="empty">Noch keine Layer angelegt.</div>`;
  const sorted = [...layers].sort((a, b) => b.layer_nr - a.layer_nr); // oben = höchste Nummer
  return `<div class="stadium-stack">
    ${sorted.map((l) => `
      <div class="stadium-layer ${l.status === 'FERTIG' ? 'fertig' : ''} ${l.status === 'LAEUFT' ? 'laeuft' : ''}" title="${escapeHtml(l.name)} — ${STATUS_LABEL[l.status]}">
        <span class="layer-nr">L${l.layer_nr}</span>
        <span class="layer-name">${escapeHtml(l.name)}</span>
        <span class="layer-status">${l.status === 'FERTIG' ? '✅' : l.status === 'LAEUFT' ? '⏳' : l.status === 'PAUSIERT' ? '⏸' : '⬜'}</span>
      </div>`).join("")}
  </div>`;
}

async function renderStadion() {
  $app.innerHTML = `<div class="empty">Lade Baustelle …</div>`;
  const canAssign = state.me.is_admin || state.me.kann_aufgaben_zuweisen;
  const [{ layers }, spieler, blockLayers] = await Promise.all([
    api("/stadion/layers"),
    canAssign ? api("/users/active") : Promise.resolve({ users: [] }),
    loadBlockLayers(),
  ]);
  const fertig = layers.filter((l) => l.status === "FERTIG").length;
  const layerProzent = layers.length ? Math.round((fertig / layers.length) * 100) : 0;

  $app.innerHTML = `
    <h1>🏟️ Stadion-Bau</h1>
    <div class="subtitle">Das Stadion entsteht Layer für Layer — jede fertige Blocklage färbt sich ein.</div>

    <div class="panel">
      <h2>Baufortschritt</h2>
      <div class="stadium-progress-wrap">
        <div class="stadium-progress-count">${fertig} von ${layers.length} Layern fertig</div>
        <div class="stadium-progress"><div class="stadium-progress-fill" style="width:${layerProzent}%"></div></div>
        <div class="stadium-progress-percent">${layerProzent}%</div>
      </div>
      ${stadiumVisualHtml(layers)}
    </div>

    ${canAssign ? `
    <div class="panel">
      <h2>Neue Layer anlegen</h2>
      <form id="layerForm" class="task-form">
        <input type="text" name="name" placeholder="z. B. Fundament, Rang 1, Dachkonstruktion …" required />
        ${zeitEingabeHtml()}
        ${terminEingabeHtml()}
        ${blockLayerSelectHtml(blockLayers, 0)}
        <div class="assignment-box" style="flex:1;min-width:260px;">
          <div class="assignment-mode">
            <button type="button" class="active" data-assignment-mode="single">👤 Eine Person</button>
            <button type="button" data-assignment-mode="multiple">👥 Mehrere Personen</button>
          </div>
          <select name="zustaendig_user_id" class="select-dark" data-single-assignment>
            <option value="">— niemand zuweisen —</option>
            ${spieler.users.map((u) => `<option value="${u.id}">${escapeHtml(u.vorname)} ${escapeHtml(u.nachname)}</option>`).join("")}
          </select>
          <div class="assignment-picker hidden" data-multi-assignment data-assignment-picker>
            <button type="button" class="assignment-trigger" data-assignment-trigger><span class="label">Spieler auswählen …</span><span class="count"></span>⌄</button>
            <div class="assignment-menu" data-assignment-menu hidden>
              ${spieler.users.map((u) => `<label class="assignment-option"><input type="checkbox" name="zustaendig_user_ids" value="${u.id}" data-name="${escapeHtml(u.vorname + " " + u.nachname)}"><span>${escapeHtml(u.vorname)} ${escapeHtml(u.nachname)}<small>${escapeHtml(u.gamertag)}</small></span></label>`).join("")}
            </div>
          </div>
        </div>
        ${state.me.is_admin ? `<input type="number" name="punkte" min="0" placeholder="Punkte" class="num-input" style="width:90px;height:40px;" />` : ""}
        <button class="btn small" type="submit">Layer anlegen</button>
      </form>
    </div>` : ""}

    <div class="panel">
      <h2>Alle Layer im Detail</h2>
      ${layers.length ? `<ul class="task-list">${layers.slice().reverse().map((l) => layerItemHtml(l, canAssign, spieler.users, blockLayers)).join("")}</ul>` : `<div class="empty">Noch keine Layer angelegt. ${canAssign ? "Leg oben die erste an!" : "Frag einen Vorarbeiter."}</div>`}
    </div>
  `;

  if (canAssign) {
    document.getElementById("layerForm").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api("/stadion/layers", {
          method: "POST",
          body: JSON.stringify({
            name: f.get("name"),
            erwartete_minuten: getErwarteteMinuten(e.target),
            datum: f.get("geplant_datum") || "",
            zeit: f.get("geplant_zeit") || "",
            blocklayer_nr: Number(f.get("blocklayer_nr")) || 0,
            zustaendig_user_ids: (() => {
              const multi = getSelectedAssignmentIds(e.target);
              const single = f.get("zustaendig_user_id");
              return multi.length ? multi : (single ? [Number(single)] : []);
            })(),
            punkte: f.get("punkte") ? Number(f.get("punkte")) : 0,
          }),
        });
        renderStadion();
      } catch (err) { alert(err.message); }
    };
  }

  document.querySelectorAll("[data-assignment-mode]").forEach((b) => b.onclick = () => {
    setAssignmentMode(document.getElementById("layerForm"), b.dataset.assignmentMode === "multiple");
  });
  setupAssignmentPicker(document.getElementById("layerForm"));

  document.querySelectorAll("[data-lstart]").forEach((b) => b.onclick = async () => { try { await api(`/stadion/layers/${b.dataset.lstart}/start`, { method: "POST" }); renderStadion(); } catch (e) { alert(e.message); } });
  document.querySelectorAll("[data-lpause]").forEach((b) => b.onclick = async () => { try { await api(`/stadion/layers/${b.dataset.lpause}/pause`, { method: "POST" }); renderStadion(); } catch (e) { alert(e.message); } });
  document.querySelectorAll("[data-lresume]").forEach((b) => b.onclick = async () => { try { await api(`/stadion/layers/${b.dataset.lresume}/resume`, { method: "POST" }); renderStadion(); } catch (e) { alert(e.message); } });
  document.querySelectorAll("[data-lcomplete]").forEach((b) => b.onclick = async () => { try { await api(`/stadion/layers/${b.dataset.lcomplete}/complete`, { method: "POST" }); renderStadion(); } catch (e) { alert(e.message); } });
  startWorkTimerTicker();

  document.querySelectorAll("[data-ldelete]").forEach((b) => b.onclick = async () => {
    if (!confirm("Layer wirklich löschen?")) return;
    try { await api(`/stadion/layers/${b.dataset.ldelete}`, { method: "DELETE" }); renderStadion(); } catch (e) { alert(e.message); }
  });

  // Neu-Zuweisen-Steuerelemente (Picker öffnen/schließen + Speichern)
  wireReassignControls(renderStadion);
  setupAssignmentPicker(document);
  // "🧱 Blöcke"-Buttons + Blockliste-Schnellauswahl je Layer
  wireBlocksControls(renderStadion);
  // Termin-Schnellbearbeitung (Datum/Uhrzeit direkt an der Layer ändern)
  wireTerminControls(renderStadion);
}

function layerItemHtml(l, canAssign, spielerUsers = [], blockLayers = []) {
  const cls = l.status === "FERTIG" ? "done" : "";
  const actions = layerActionsHtml(l, { includeDelete: canAssign });
  const assignees = l.assignees || [];
  const names = assignees.length
    ? assignees.map((a) => `${a.vorname} ${a.nachname}${assignees.length > 1 ? ` (${a.anteil || 100}%)` : ""}`).join(" / ")
    : (l.zustaendig_name || "");
  const splitHint = assignees.length > 1 && l.punkte ? `<div class="task-meta">🪙 Punkte werden gleichmäßig auf ${assignees.length} Spieler verteilt.</div>` : "";
  // Admin/Berechtigte können jederzeit neu zuweisen — auch nach Zuweisung oder freiwilliger Annahme.
  const reassignBtn = canAssign ? reassignControlHtml("layer", l.id, spielerUsers, assignees.map((a) => a.id)) : "";
  // Verknüpfte Blockliste: Sprung-Button für alle, Schnellauswahl zum Ändern nur für Berechtigte.
  const blocksBtn = blocksJumpButtonHtml(l);
  const blockQuickEdit = canAssign ? blockLinkQuickEditHtml(l.id, l.blocklayer_nr, blockLayers) : "";
  // Admin/Berechtigte können den geplanten Termin jederzeit direkt hier ändern.
  const terminEdit = canAssign ? terminQuickEditHtml("layer", l.id, l.geplant_datum, l.geplant_zeit) : "";
  return `<li class="task-item ${cls}">
    <span class="titel">L${l.layer_nr} · ${escapeHtml(l.name)}${l.punkte ? `<span class="punkte-tag">🪙 ${l.punkte}</span>` : ""}${names ? `<div class="task-meta">👷 ${escapeHtml(names)}</div>` : ""}${splitHint}${terminBadgeHtml(l)}</span>
    <span class="status-pill ${l.status}">${STATUS_LABEL[l.status] || l.status}</span>
    ${layerTimerHtml(l)}
    ${blocksBtn}
    ${actions}
    ${reassignBtn}
    ${blockQuickEdit}
    ${terminEdit}
  </li>`;
}

// ---------- Blöcke (Litematica-Materiallisten je Bau-Layer) ----------

async function renderBloecke() {
  $app.innerHTML = `<div class="empty">Lade Blocklisten …</div>`;
  const layers = await loadBlockLayers();
  const focus = state.blockFocusNr || null;

  $app.innerHTML = `
    <h1>🧱 Blöcke · Litematica-Bauplan</h1>
    <div class="subtitle">Materialliste je Bau-Layer aus dem Litematica-Bauplan — ${layers.length} Layer mit Blöcken insgesamt. Im Stadion-Bau-Tab kann jede Stadion-Layer mit einem dieser Layer verknüpft werden.</div>

    ${layers.length ? `
    <div class="panel">
      <h2>Schnellsprung</h2>
      <div class="block-layer-nav">
        ${layers.map((l) => `<button type="button" class="block-layer-chip ${focus === l.nr ? "active" : ""}" data-blockjump="${l.nr}">L${l.nr}</button>`).join("")}
      </div>
    </div>
    ${layers.map((l) => blockLayerCardHtml(l, focus === l.nr)).join("")}
    ` : `<div class="empty">Es wurden noch keine Blocklisten aus einem Bauplan geladen.</div>`}
  `;

  document.querySelectorAll("[data-blockjump]").forEach((b) => b.onclick = () => {
    state.blockFocusNr = Number(b.dataset.blockjump);
    renderBloecke();
  });

  if (focus) {
    setTimeout(() => {
      const el = document.getElementById("blocklayer-" + focus);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }
}

function blockLayerCardHtml(l, isFocus) {
  return `<div class="panel block-layer-card ${isFocus ? "focused" : ""}" id="blocklayer-${l.nr}">
    <h2>Layer ${l.nr} <span class="punkte-tag">${l.total} Blöcke</span></h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Block</th><th>Anzahl</th></tr></thead>
        <tbody>${l.blocks.map((b) => `<tr><td>${escapeHtml(b.label)}</td><td>${b.count}</td></tr>`).join("")}</tbody>
      </table>
    </div>
  </div>`;
}

// ---------- Zeitstrahl (24-Stunden-Tagesplan für geplante Aufgaben, Layer & Kalender) ----------
// Zeigt für ein wählbares Datum alle Aufgaben, Stadion-Layer UND Kalender-
// Einträge/Events, die einen geplanten Termin (Datum + Uhrzeit) haben, als
// Balken auf einer 24-Stunden-Achse an. Die Balkenlänge kommt aus der
// jeweiligen "Erwarteten Zeit"/Dauer (erwartete_sekunden) — ohne gesetzte
// Dauer wird ein kleiner Platzhalter-Balken (30 Min.) gezeigt, damit der
// Termin trotzdem sichtbar ist.
//
// Überzogene Termine (nur Aufgaben/Layer, die wirklich laufen können): Läuft
// ein Termin länger als die erwartete Zeit, wird der Balken rot und wächst
// live mit der tatsächlich verbrauchten Zeit mit. Kalender-Einträge/Events
// haben keinen Lauf-Status und werden daher einfach mit ihrer festen Dauer
// angezeigt — in einer eigenen Farbe, damit sie sich von Aufgaben/Layern
// abheben.

// Baut aus Aufgaben, Stadion-Layern und Kalender-Einträgen die Liste der
// Zeitstrahl-Einträge für ein bestimmtes Datum. Wird sowohl vom vollen
// Zeitstrahl-Tab als auch vom kompakten "Heutiger Zeitstrahl"-Panel auf dem
// Dashboard genutzt, damit beide exakt dieselbe Logik verwenden.
function buildZeitstrahlItems(tasks, layers, eintraege, datum) {
  const items = [];
  tasks.forEach((t) => {
    if (t.geplant_datum === datum && t.geplant_zeit) {
      items.push({
        kind: "task", titel: t.titel, zeit: t.geplant_zeit, status: t.status,
        erwartetSek: t.erwartete_sekunden || 0,
        verbrauchtSek: t.verbrauchte_sekunden || 0,
        startZeitIso: t.start_zeit || null,
      });
    }
  });
  layers.forEach((l) => {
    if (l.geplant_datum === datum && l.geplant_zeit) {
      items.push({
        kind: "layer", titel: `L${l.layer_nr} · ${l.name}`, zeit: l.geplant_zeit, status: l.status,
        erwartetSek: l.erwartete_sekunden || 0,
        verbrauchtSek: l.verbrauchte_sekunden || 0,
        startZeitIso: l.start_zeit || null,
      });
    }
  });
  eintraege.forEach((e) => {
    if (e.datum === datum && e.zeit) {
      items.push({
        kind: e.typ === "EVENT" ? "event" : "kalender",
        titel: (e.typ === "EVENT" ? "🎉 " : "") + e.titel,
        zeit: e.zeit,
        status: "",
        erwartetSek: e.erwartete_sekunden || 0,
        verbrauchtSek: 0,
        startZeitIso: null,
      });
    }
  });
  return items;
}

// silent=true wird beim automatischen 20-Sekunden-Refresh genutzt (siehe
// unten) und überspringt den "Lade Zeitstrahl …"-Platzhalter, damit der
// Zeitstrahl-Tab beim Live-Update nicht mehr kurz aufblitzt/flackert.
async function renderZeitstrahl(opts = {}) {
  const silent = opts.silent === true;
  if (state.zeitstrahlHandle) clearInterval(state.zeitstrahlHandle);
  if (!silent) $app.innerHTML = `<div class="empty">Lade Zeitstrahl …</div>`;
  if (!state.zeitstrahlDatum) state.zeitstrahlDatum = todayStrLocal();
  const datum = state.zeitstrahlDatum;
  const [{ tasks }, { layers }, { eintraege }] = await Promise.all([api("/tasks"), api("/stadion/layers"), api("/kalender")]);

  const items = buildZeitstrahlItems(tasks, layers, eintraege, datum);

  const istHeute = datum === todayStrLocal();

  $app.innerHTML = `
    <h1>🕒 Zeitstrahl</h1>
    <div class="subtitle">Geplante Aufgaben, Layer & Kalender-Einträge/Events im 24-Stunden-Überblick. Termin & Dauer werden beim Anlegen festgelegt (oder direkt dort nachträglich geändert). Läuft etwas über die geplante Zeit hinaus, wächst der Balken rot weiter.</div>

    <div class="panel">
      <div class="zeitstrahl-nav">
        <button type="button" class="btn small secondary" id="zsPrev">◀ Vorheriger Tag</button>
        <input type="date" id="zsDatum" value="${datum}" class="select-dark" />
        <button type="button" class="btn small secondary" id="zsToday">Heute</button>
        <button type="button" class="btn small secondary" id="zsNext">Nächster Tag ▶</button>
      </div>
      <div class="subtitle" style="margin:10px 0 0;">${fmtDatumKurz(datum)}</div>
      ${zeitstrahlTimelineHtml(items, istHeute)}
      <div class="zeitstrahl-legende">
        <span><i style="background:#48b96b"></i> Aufgabe</span>
        <span><i style="background:#5f8fc4"></i> Stadion-Layer</span>
        <span><i style="background:#d9a441"></i> Kalender-Eintrag</span>
        <span><i style="background:#b485e0"></i> Event</span>
        <span><i style="background:#48b96b;outline:2px solid var(--yellow,#f2c744)"></i> läuft gerade</span>
        <span><i style="background:#d9534f"></i> über der geplanten Zeit</span>
        <span><i style="background:#d9534f;opacity:.55"></i> erledigt (war überzogen)</span>
      </div>
    </div>
  `;

  document.getElementById("zsDatum").onchange = (e) => { state.zeitstrahlDatum = e.target.value || todayStrLocal(); renderZeitstrahl(); };
  document.getElementById("zsToday").onclick = () => { state.zeitstrahlDatum = todayStrLocal(); renderZeitstrahl(); };
  document.getElementById("zsPrev").onclick = () => { state.zeitstrahlDatum = shiftDatum(state.zeitstrahlDatum, -1); renderZeitstrahl(); };
  document.getElementById("zsNext").onclick = () => { state.zeitstrahlDatum = shiftDatum(state.zeitstrahlDatum, 1); renderZeitstrahl(); };

  // Laufen gerade Termine, wird die Seite alle 20 Sekunden neu geladen, damit
  // überzogene Balken live weiterwachsen — jetzt im "silent"-Modus (siehe oben).
  const hatLaufende = items.some((it) => it.status === "LAEUFT");
  if (hatLaufende) {
    state.zeitstrahlHandle = setInterval(() => {
      if (state.view === "zeitstrahl") renderZeitstrahl({ silent: true });
    }, 20000);
  }
}

// Verschiebt ein Datum (YYYY-MM-DD) um deltaDays Tage.
function shiftDatum(datum, deltaDays) {
  const d = new Date(datum + "T00:00:00");
  d.setDate(d.getDate() + deltaDays);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Wandelt "HH:MM" in Minuten seit Mitternacht um.
function zeitToMinuten(zeit) {
  const [h, m] = zeit.split(":").map(Number);
  return h * 60 + (m || 0);
}

// Berechnet die tatsächlich verbrauchte Zeit (in Sekunden) eines Zeitstrahl-Eintrags
// bis zum übergebenen Zeitpunkt: bereits abgeschlossene Phasen (verbrauchtSek) plus
// die laufende Phase, falls der Termin gerade läuft.
function berechneAktuelleSekunden(it, jetztMs) {
  let sek = it.verbrauchtSek || 0;
  if (it.status === "LAEUFT" && it.startZeitIso) {
    sek += Math.max(0, (jetztMs - new Date(it.startZeitIso).getTime()) / 1000);
  }
  return sek;
}

// Baut die eigentliche 24-Stunden-Balkenansicht. Überlappende Termine bekommen
// automatisch eigene Spuren (Zeilen) zugewiesen, wie bei einem kleinen Gantt-Diagramm.
// Balken, die ihre geplante Dauer überschreiten, werden rot und so lang wie die
// tatsächlich verbrauchte Zeit (statt der ursprünglich geplanten).
function zeitstrahlTimelineHtml(items, istHeute) {
  if (!items.length) return `<div class="empty" style="margin-top:14px;">Für diesen Tag sind noch keine Termine geplant.</div>`;

  const jetztMs = Date.now();
  const sorted = [...items].sort((a, b) => zeitToMinuten(a.zeit) - zeitToMinuten(b.zeit));
  const laneEnden = []; // laneEnden[i] = Ende (in Minuten) der letzten Belegung dieser Spur
  sorted.forEach((it) => {
    const start = zeitToMinuten(it.zeit);
    const aktuelleSek = berechneAktuelleSekunden(it, jetztMs);
    const geplantDauerMin = it.erwartetSek > 0 ? it.erwartetSek / 60 : 30; // Platzhalter ohne gesetzte Dauer
    const aktuelleDauerMin = aktuelleSek / 60;
    const isOvertime = it.erwartetSek > 0 && aktuelleSek > it.erwartetSek;
    const effektiveDauerMin = Math.max(10, geplantDauerMin, aktuelleDauerMin);
    const ende = start + effektiveDauerMin;
    it._start = start;
    it._ende = ende;
    it._overtime = isOvertime;
    let lane = laneEnden.findIndex((endeBelegt) => endeBelegt <= start);
    if (lane === -1) { lane = laneEnden.length; laneEnden.push(ende); }
    else laneEnden[lane] = ende;
    it._lane = lane;
  });
  const laneCount = laneEnden.length;
  const laneHoehe = 54;
  const gesamtHoehe = laneCount * laneHoehe + 24;

  const stunden = Array.from({ length: 25 }, (_, i) => i);
  const jetztMin = new Date().getHours() * 60 + new Date().getMinutes();

  return `
    <div class="zeitstrahl-wrap">
      <div class="zeitstrahl-hours">
        ${stunden.map((h) => `<span class="zeitstrahl-hour" style="left:${(h / 24) * 100}%">${String(h).padStart(2, "0")}</span>`).join("")}
      </div>
      <div class="zeitstrahl-track" style="height:${gesamtHoehe}px">
        ${stunden.map((h) => `<div class="zeitstrahl-gridline" style="left:${(h / 24) * 100}%"></div>`).join("")}
        ${istHeute ? `<div class="zeitstrahl-nowline" style="left:${(jetztMin / 1440) * 100}%" title="Jetzt"></div>` : ""}
        ${sorted.map((it) => {
          const left = (it._start / 1440) * 100;
          const width = Math.max(0.9, ((it._ende - it._start) / 1440) * 100);
          const top = it._lane * laneHoehe + 14;
          const fertigStatus = it.status === "ERLEDIGT" || it.status === "FERTIG";
          const cls = [
            fertigStatus ? "fertig" : "",
            it.status === "LAEUFT" ? "laeuft" : "",
            it._overtime ? "overtime" : "",
          ].filter(Boolean).join(" ");
          return `<div class="zeitstrahl-block ${it.kind} ${cls}" style="left:${left}%;width:${width}%;top:${top}px;height:${laneHoehe - 12}px" title="${escapeHtml(it.titel)} · ${it.zeit} Uhr${it._overtime ? " · über der geplanten Zeit" : ""}">
            <span class="zeitstrahl-block-zeit">${it.zeit}</span>
            <span class="zeitstrahl-block-titel">${escapeHtml(it.titel)}</span>
          </div>`;
        }).join("")}
      </div>
    </div>`;
}

// ---------- Punkte-Shop ----------

async function renderShop() {
  $app.innerHTML = `<div class="empty">Lade Shop …</div>`;
  const [{ items }, { kaeufe }] = await Promise.all([api("/shop/items"), api("/shop/kaeufe")]);

  $app.innerHTML = `
    <h1>🛒 Punkte-Shop</h1>
    <div class="subtitle">Du hast <strong>🪙 ${state.me.punkte}</strong> Punkte. Gib sie hier aus!</div>

    ${state.me.is_admin ? `
    <div class="panel">
      <h2>Neues Angebot erstellen</h2>
      <form id="shopForm" class="task-form">
        <input type="text" name="titel" placeholder="z. B. Diamantschwert" required />
        <input type="text" name="beschreibung" placeholder="Was bekommt man dafür?" style="flex:2;min-width:220px;" />
        <input type="number" name="kosten" min="1" placeholder="Punktekosten" class="num-input" style="width:120px;height:40px;" required />
        <button class="btn small" type="submit">Angebot anlegen</button>
      </form>
    </div>` : ""}

    <div class="panel">
      <h2>Angebote</h2>
      ${items.length ? `<div class="shop-grid">${items.map((i) => shopItemHtml(i)).join("")}</div>` : `<div class="empty">Noch keine Angebote im Shop.</div>`}
    </div>

    <div class="panel">
      <h2>${state.me.is_admin ? "Alle Bestellungen" : "Deine Bestellungen"}</h2>
      ${kaeufe.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr>${state.me.is_admin ? "<th>Spieler</th>" : ""}<th>Angebot</th><th>Kosten</th><th>Datum</th><th>Status</th>${state.me.is_admin ? "<th></th>" : ""}</tr></thead>
          <tbody>${kaeufe.map((k) => `<tr>
            ${state.me.is_admin ? `<td>${escapeHtml(k.user_name)}</td>` : ""}
            <td>${escapeHtml(k.item_titel)}</td><td>🪙 ${k.kosten}</td><td>${fmtDate(k.erstellt_am)}</td>
            <td>${k.status === "ABGESCHLOSSEN" ? "✅ Ausgeliefert" : "⏳ Offen"}</td>
            ${state.me.is_admin ? `<td>${k.status === "OFFEN" ? `<button class="btn small secondary" data-fulfil="${k.id}">Als erledigt markieren</button>` : ""}</td>` : ""}
          </tr>`).join("")}</tbody>
        </table>
      </div>` : `<div class="empty">Noch keine Bestellungen.</div>`}
    </div>
  `;

  if (state.me.is_admin) {
    document.getElementById("shopForm").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api("/shop/items", { method: "POST", body: JSON.stringify({ titel: f.get("titel"), beschreibung: f.get("beschreibung"), kosten: Number(f.get("kosten")) }) });
        renderShop();
      } catch (err) { alert(err.message); }
    };
    document.querySelectorAll("[data-toggleitem]").forEach((b) => b.onclick = async () => { try { await api(`/shop/items/${b.dataset.toggleitem}/toggle`, { method: "POST" }); renderShop(); } catch (e) { alert(e.message); } });
    document.querySelectorAll("[data-delitem]").forEach((b) => b.onclick = async () => {
      if (!confirm("Angebot wirklich löschen?")) return;
      try { await api(`/shop/items/${b.dataset.delitem}`, { method: "DELETE" }); renderShop(); } catch (e) { alert(e.message); }
    });
    document.querySelectorAll("[data-fulfil]").forEach((b) => b.onclick = async () => {
      try { await api(`/shop/kaeufe/${b.dataset.fulfil}/erledigt`, { method: "POST" }); renderShop(); } catch (e) { alert(e.message); }
    });
  }
  document.querySelectorAll("[data-buy]").forEach((b) => b.onclick = async () => {
    if (!confirm(`Für ${b.dataset.kosten} Punkte kaufen?`)) return;
    try { await api(`/shop/items/${b.dataset.buy}/kaufen`, { method: "POST" }); state.me = await api("/me"); renderShop(); }
    catch (e) { alert(e.message); }
  });
}

function shopItemHtml(i) {
  const leistbar = state.me.punkte >= i.kosten;
  return `<div class="shop-card ${i.aktiv ? "" : "inaktiv"}">
    <div class="shop-card-title">${escapeHtml(i.titel)}</div>
    ${i.beschreibung ? `<div class="shop-card-desc">${escapeHtml(i.beschreibung)}</div>` : ""}
    <div class="shop-card-foot">
      <span class="punkte-tag big">🪙 ${i.kosten}</span>
      ${state.me.is_admin
        ? `<span class="shop-admin-actions"><button class="btn small secondary" data-toggleitem="${i.id}">${i.aktiv ? "Deaktivieren" : "Aktivieren"}</button> <button class="btn small secondary" data-delitem="${i.id}">🗑</button></span>`
        : `<button class="btn small" data-buy="${i.id}" data-kosten="${i.kosten}" ${i.aktiv && leistbar ? "" : "disabled"}>${!i.aktiv ? "Nicht verfügbar" : leistbar ? "Kaufen" : "Zu wenig Punkte"}</button>`}
    </div>
  </div>`;
}

// ---------- Kalender ----------

async function renderKalender() {
  $app.innerHTML = `<div class="empty">Lade Kalender …</div>`;
  const { eintraege } = await api("/kalender");
  const heute = todayStrLocal();
  const kommend = eintraege.filter((e) => e.datum >= heute);
  const vergangen = eintraege.filter((e) => e.datum < heute);

  $app.innerHTML = `
    <h1>📅 Kalender</h1>
    <div class="subtitle">Termine & Events der Bau-Crew. Bei Events kannst du abstimmen, ob du Zeit hast. Trag optional eine Dauer ein, dann erscheint der Termin auch im Zeitstrahl.</div>

    ${state.me.kann_kalender_erstellen || state.me.is_admin ? `
    <div class="panel">
      <h2>Neuen Eintrag erstellen</h2>
      <form id="kalForm" class="task-form" style="flex-wrap:wrap;">
        <select name="typ" class="select-dark">
          <option value="EINTRAG">Eintrag</option>
          <option value="EVENT">Event (mit Abstimmung)</option>
        </select>
        <input type="text" name="titel" placeholder="Titel" required style="flex:1;min-width:180px;" />
        <input type="date" name="datum" class="select-dark" required />
        <input type="time" name="zeit" class="select-dark" />
        ${zeitEingabeHtml()}
        <input type="text" name="beschreibung" placeholder="Beschreibung (optional, mehrere Zeilen möglich)" style="flex:2;min-width:220px;" />
        <button class="btn small" type="submit">Eintragen</button>
      </form>
    </div>` : ""}

    <div class="panel">
      <h2>Kommende Termine</h2>
      ${kommend.length ? `<div class="kalender-list">${kommend.map(kalenderItemHtml).join("")}</div>` : `<div class="empty">Keine kommenden Termine.</div>`}
    </div>

    ${vergangen.length ? `
    <div class="panel">
      <h2>Vergangen</h2>
      <div class="kalender-list">${vergangen.slice().reverse().slice(0, 10).map(kalenderItemHtml).join("")}</div>
    </div>` : ""}
  `;

  if (state.me.kann_kalender_erstellen || state.me.is_admin) {
    document.getElementById("kalForm").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api("/kalender", {
          method: "POST",
          body: JSON.stringify({
            typ: f.get("typ"),
            titel: f.get("titel"),
            datum: f.get("datum"),
            zeit: f.get("zeit") || null,
            beschreibung: f.get("beschreibung"),
            erwartete_minuten: getErwarteteMinuten(e.target),
          }),
        });
        renderKalender();
      } catch (err) { alert(err.message); }
    };
  }
  document.querySelectorAll("[data-kaldelete]").forEach((b) => b.onclick = async () => {
    if (!confirm("Eintrag wirklich löschen?")) return;
    try { await api(`/kalender/${b.dataset.kaldelete}`, { method: "DELETE" }); renderKalender(); } catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-vote]").forEach((b) => b.onclick = async () => {
    try { await api(`/kalender/${b.dataset.entry}/vote`, { method: "POST", body: JSON.stringify({ antwort: b.dataset.vote }) }); renderKalender(); }
    catch (e) { alert(e.message); }
  });
}

function todayStrLocal() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Kleine Info-Zeile mit der eingetragenen Dauer eines Kalendereintrags/Events (falls gesetzt).
function kalenderDauerBadgeHtml(e) {
  if (!e.erwartete_sekunden) return "";
  return `<div class="kalender-meta">⏳ Dauer: ${fmtHM(e.erwartete_sekunden)} Std.</div>`;
}

function kalenderItemHtml(e) {
  const kannLoeschen = state.me.is_admin || e.erstellt_von === state.me.id;
  if (e.typ === "EVENT") {
    return `<div class="kalender-item event">
      <div class="kalender-datum">${fmtDatumKurz(e.datum)}${e.zeit ? " · " + e.zeit + " Uhr" : ""}</div>
      <div class="kalender-titel">🎉 ${escapeHtml(e.titel)} ${kannLoeschen ? `<button class="ghost-btn tiny" data-kaldelete="${e.id}">🗑</button>` : ""}</div>
      ${e.beschreibung ? `<div class="kalender-desc">${nl2br(escapeHtml(e.beschreibung))}</div>` : ""}
      ${kalenderDauerBadgeHtml(e)}
      <div class="kalender-meta">von ${escapeHtml(e.ersteller_name || "?")}</div>
      <div class="vote-row">
        <button class="btn small ${e.meine_stimme === 'ZEIT' ? '' : 'secondary'}" data-vote="ZEIT" data-entry="${e.id}">✅ Zeit (${e.zeit_count})</button>
        <button class="btn small ${e.meine_stimme === 'KEINE_ZEIT' ? '' : 'secondary'}" data-vote="KEINE_ZEIT" data-entry="${e.id}">❌ Keine Zeit (${e.keine_zeit_count})</button>
      </div>
    </div>`;
  }
  return `<div class="kalender-item">
    <div class="kalender-datum">${fmtDatumKurz(e.datum)}${e.zeit ? " · " + e.zeit + " Uhr" : ""}</div>
    <div class="kalender-titel">${escapeHtml(e.titel)} ${kannLoeschen ? `<button class="ghost-btn tiny" data-kaldelete="${e.id}">🗑</button>` : ""}</div>
    ${e.beschreibung ? `<div class="kalender-desc">${nl2br(escapeHtml(e.beschreibung))}</div>` : ""}
    ${kalenderDauerBadgeHtml(e)}
    <div class="kalender-meta">von ${escapeHtml(e.ersteller_name || "?")}</div>
  </div>`;
}

// ---------- Plan für die ersten drei Tage ----------
// Der Text ist im Backend hinterlegt (Endpunkt /plan3tage) und kann von
// Admins direkt hier im Tab bearbeitet und gespeichert werden — es muss
// also niemand mehr eine PDF verschicken. Einfache Text-Formatierung:
//   # Titel         → große grüne Überschrift
//   ## Tag-Titel    → Tages-Überschrift (rot)
//   @ Zeitmarke     → zentrierte Zeitangabe (z. B. "Ungefähr 20:00")
//   > Hinweis/Pause → hervorgehobener Hinweis (z. B. Pausen)
//   ! Wichtig       → auffällige Warnung/Erinnerung (z. B. Wecker)
//   Leerzeile       → zusätzlicher Abstand
//   alles andere    → normale Zeile/Aufgabe

// Wandelt den rohen Plan-Text (siehe Formatierungs-Legende oben) in schön
// formatiertes HTML um.
function renderPlanTextHtml(text) {
  const lines = (text || "").split("\n");
  let html = "";
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) { html += `<div class="plan-space"></div>`; continue; }
    if (line.startsWith("# ")) { html += `<h1 class="plan-title">${escapeHtml(line.slice(2).trim())}</h1>`; continue; }
    if (line.startsWith("## ")) { html += `<h2 class="plan-day">${escapeHtml(line.slice(3).trim())}</h2>`; continue; }
    if (line.startsWith("@ ")) { html += `<div class="plan-time">${escapeHtml(line.slice(2).trim())}</div>`; continue; }
    if (line.startsWith("> ")) { html += `<div class="plan-note">${escapeHtml(line.slice(2).trim())}</div>`; continue; }
    if (line.startsWith("! ")) { html += `<div class="plan-alert">${escapeHtml(line.slice(2).trim())}</div>`; continue; }
    html += `<p class="plan-line">${escapeHtml(line)}</p>`;
  }
  return html;
}

async function renderPlan3Tage() {
  $app.innerHTML = `<div class="empty">Lade Plan …</div>`;
  const data = await api("/plan3tage");
  const isAdmin = state.me.is_admin;

  $app.innerHTML = `
    <h1>📋 Plan für die ersten drei Tage</h1>
    <div class="subtitle">Der Ablaufplan für den Baustart — direkt hier zum Nachlesen.${data.aktualisiert_am ? ` Zuletzt geändert von ${escapeHtml(data.aktualisiert_von || "?")} am ${fmtDate(data.aktualisiert_am)}.` : ""}</div>

    ${isAdmin ? `
    <div class="panel">
      <button type="button" class="btn small secondary" id="planEditToggle">✏️ Text bearbeiten</button>
      <div id="planEditBox" hidden style="margin-top:14px;">
        <textarea id="planEditArea" class="select-dark" style="width:100%;min-height:360px;font-family:monospace;font-size:.92em;line-height:1.5;">${escapeHtml(data.text)}</textarea>
        <div class="subtitle" style="margin:10px 0;">Formatierung: <code># Titel</code> (große Überschrift) · <code>## Tag</code> (Tages-Überschrift) · <code>@ Zeitmarke</code> · <code>&gt; Hinweis/Pause</code> · <code>! Wichtig</code> · Leerzeile = Abstand. Alles andere wird als normale Zeile angezeigt.</div>
        <button type="button" class="btn small" id="planSaveBtn">Speichern</button>
        <span id="planSaveStatus" class="subtitle" style="margin-left:10px;"></span>
      </div>
    </div>` : ""}

    <div class="panel kodex-panel plan-panel">
      ${renderPlanTextHtml(data.text)}
    </div>
  `;

  if (isAdmin) {
    document.getElementById("planEditToggle").onclick = () => {
      const box = document.getElementById("planEditBox");
      box.hidden = !box.hidden;
    };
    document.getElementById("planSaveBtn").onclick = async () => {
      const val = document.getElementById("planEditArea").value;
      const statusEl = document.getElementById("planSaveStatus");
      statusEl.textContent = "Speichere …";
      try {
        await api("/plan3tage", { method: "POST", body: JSON.stringify({ text: val }) });
        renderPlan3Tage();
      } catch (e) {
        statusEl.textContent = "";
        alert(e.message);
      }
    };
  }
}

// ---------- Dokumente & Dateien ----------

function fmtBytes(n) {
  if (!n && n !== 0) return "–";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function dateiIcon(contentType) {
  const t = contentType || "";
  if (t.includes("pdf")) return "📕";
  if (t.startsWith("image/")) return "🖼️";
  if (t.includes("zip") || t.includes("rar") || t.includes("7z")) return "🗜️";
  if (t.includes("word") || t.includes("document")) return "📝";
  if (t.includes("sheet") || t.includes("excel")) return "📊";
  if (t.includes("presentation") || t.includes("powerpoint")) return "📽️";
  if (t.startsWith("video/")) return "🎬";
  if (t.startsWith("audio/")) return "🎵";
  return "📄";
}

async function renderDateien() {
  $app.innerHTML = `<div class="empty">Lade Dokumente …</div>`;
  const { dateien } = await api("/dateien");

  $app.innerHTML = `
    <h1>📎 Dokumente & Dateien</h1>
    <div class="subtitle">${state.me.is_admin ? "Lade Baupläne, Regeln oder sonstige Dokumente hoch — die ganze Crew kann sie hier herunterladen." : "Hier findest du alle Dokumente, die der Admin hochgeladen hat."}</div>

    ${state.me.is_admin ? `
    <div class="panel">
      <h2>Neue Datei hochladen</h2>
      <form id="dateiForm" class="task-form" style="flex-wrap:wrap;">
        <input type="file" name="datei" id="dateiInput" required style="flex:1;min-width:220px;" />
        <input type="text" name="beschreibung" placeholder="Beschreibung (optional)" style="flex:2;min-width:220px;" />
        <button class="btn small" type="submit">Hochladen</button>
      </form>
      <div id="dateiUploadStatus" class="subtitle" style="margin:10px 0 0;"></div>
    </div>` : ""}

    <div class="panel">
      <h2>Alle Dokumente (${dateien.length})</h2>
      ${dateien.length ? `<ul class="task-list">${dateien.map(dateiItemHtml).join("")}</ul>` : `<div class="empty">Noch keine Dateien hochgeladen.</div>`}
    </div>
  `;

  if (state.me.is_admin) {
    document.getElementById("dateiForm").onsubmit = async (e) => {
      e.preventDefault();
      const form = e.target;
      const fileInput = document.getElementById("dateiInput");
      if (!fileInput.files.length) return;
      const statusEl = document.getElementById("dateiUploadStatus");
      const fd = new FormData();
      fd.append("datei", fileInput.files[0]);
      fd.append("beschreibung", form.beschreibung.value || "");
      statusEl.textContent = "Lade hoch …";
      try {
        const headers = {};
        if (state.token) headers.authorization = "Bearer " + state.token;
        const res = await fetch(API + "/dateien/upload", { method: "POST", headers, body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Upload fehlgeschlagen.");
        statusEl.textContent = "";
        renderDateien();
      } catch (err) {
        statusEl.textContent = "";
        alert(err.message);
      }
    };
  }

  document.querySelectorAll("[data-dateidownload]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.dateidownload;
    const name = b.dataset.dateiname;
    const originalText = b.textContent;
    b.textContent = "Lädt …";
    try {
      const headers = {};
      if (state.token) headers.authorization = "Bearer " + state.token;
      const res = await fetch(`${API}/dateien/${id}/download`, { headers });
      if (!res.ok) throw new Error("Download fehlgeschlagen.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err.message);
    } finally {
      b.textContent = originalText;
    }
  });

  document.querySelectorAll("[data-dateidelete]").forEach((b) => b.onclick = async () => {
    if (!confirm("Diese Datei wirklich löschen?")) return;
    try { await api(`/dateien/${b.dataset.dateidelete}`, { method: "DELETE" }); renderDateien(); }
    catch (e) { alert(e.message); }
  });
}

function dateiItemHtml(d) {
  return `<li class="task-item">
    <span class="titel">${dateiIcon(d.content_type)} ${escapeHtml(d.dateiname)}<span class="punkte-tag">${fmtBytes(d.groesse_bytes)}</span>
      ${d.beschreibung ? `<div class="task-meta">${escapeHtml(d.beschreibung)}</div>` : ""}
      <div class="task-meta">von ${escapeHtml(d.hochgeladen_name || "?")} · ${fmtDate(d.hochgeladen_am)}</div>
    </span>
    <button class="btn small secondary" data-dateidownload="${d.id}" data-dateiname="${escapeHtml(d.dateiname)}">⬇ Download</button>
    ${state.me.is_admin ? `<button class="btn small secondary" data-dateidelete="${d.id}">🗑</button>` : ""}
  </li>`;
}

// ---------- Kodex ----------

function renderKodex() {
  $app.innerHTML = `
    <h1>📜 Der Kodex der Beton-Buben</h1>
    <div class="subtitle">Verabschiedet vom Vorstand, ratifiziert von der Belegschaft, ignoriert von allen — wie es sich gehört.</div>

    <div class="panel kodex-panel">
      <h2>Präambel</h2>
      <p>Wir, die Beton-Buben GmbH & Co. Baugrube, verpflichten uns hiermit feierlich, dieses Stadion zu errichten —
      Block für Block, Kaffeepause für Kaffeepause. Dieser Kodex regelt, was Excel-Tabellen nicht regeln konnten:
      unsere Ehre.</p>
    </div>

    <div class="panel kodex-panel">
      <h2>Die 12 Gebote der Baustelle</h2>
      <ol class="kodex-list">
        <li><strong>Du sollst die Stoppuhr ehren.</strong> Wer „ON" schaltet und dann Kaffee holt, betrügt nicht die Firma — er betrügt das Stadion.</li>
        <li><strong>Du sollst keine falschen Layer legen.</strong> Blöcke, die schief sind, werden im Kodex-Gericht öffentlich besprochen (bei Bedarf mit Diagramm).</li>
        <li><strong>Du sollst deine Aufgaben nicht auf ewig „LÄUFT" stehen lassen.</strong> Niemand glaubt dir, dass du seit drei Tagen an einer Treppe baust.</li>
        <li><strong>Du sollst Punkte nicht erschleichen.</strong> Selbst-Zuweisung von Bonuspunkten führt zur sofortigen Rückstufung zum Sklaven.</li>
        <li><strong>Du sollst den Admin nicht anschreien</strong>, wenn dein Shop-Kauf noch „offen" ist. Die Lieferkette ist ehrenamtlich.</li>
        <li><strong>Du sollst zu Events abstimmen</strong>, auch wenn die Antwort „keine Zeit, ich zocke was anderes" lautet. Ehrlichkeit vor Höflichkeit.</li>
        <li><strong>Du sollst dein Gruppen-Trupp nicht heimlich verlassen</strong>, ohne wenigstens ein Meme als Abschiedsgeschenk zu hinterlassen.</li>
        <li><strong>Du sollst keine Blöcke stehlen</strong>, die für höhere Layer vorgesehen sind — auch nicht „nur ausleihen".</li>
        <li><strong>Du sollst dein Avatar-Emoji mit Bedacht wählen.</strong> Ein 🐷 als Vorarbeiter wirft Fragen auf, ist aber nicht verboten.</li>
        <li><strong>Du sollst die Rangliste nicht anzweifeln</strong>, nur weil du auf Platz 7 stehst. Die Datenbank lügt nicht (meistens).</li>
        <li><strong>Du sollst dem Stadion Ehre erweisen</strong>, wenn eine Layer fertig gefärbt wird. Ein kurzes „nice" reicht völlig.</li>
        <li><strong>Du sollst diesen Kodex weitererzählen</strong> — mündlich, feierlich, am besten mit Echo-Effekt im Voice-Chat.</li>
      </ol>
    </div>

    <div class="panel kodex-panel">
      <h2>Strafenkatalog (unverbindlich, aber gefürchtet)</h2>
      <ul class="kodex-list">
        <li>Aufgabe erstellt und nie gestartet → 1× Kaffee holen für alle Online-Mitglieder</li>
        <li>Layer schief gebaut → öffentliches Foto in der Rangliste-Ehrentafel (fiktiv, aber schmerzhaft)</li>
        <li>Shop-Punkte verprasst und dann „Kredit" gefordert → Rang-Degradierung um eine Stufe (symbolisch)</li>
        <li>Diesen Kodex ungelesen weggeklickt → nichts, wir merken es eh nicht</li>
      </ul>
    </div>

    <div class="panel kodex-panel">
      <h2>Schlussformel</h2>
      <p>Erhoben von Kelle und Pickel, besiegelt mit virtuellem Beton — dieser Kodex tritt mit sofortiger Wirkung in Kraft
      und bleibt gültig, bis das Stadion eröffnet, das WLAN ausfällt oder jemand eine bessere Idee hat.
      Möge eure Online-Zeit lang und eure Aufgabenliste kurz sein. 🧱🏆</p>
    </div>
  `;
}

// ---------- Zeitlog ----------

async function renderZeitlog() {
  $app.innerHTML = `<div class="empty">Lade Zeitlog …</div>`;
  const { zeitlog } = await api("/zeitlog");

  $app.innerHTML = `
    <div class="toolbar">
      <div><h1>Zeitlog</h1><div class="subtitle" style="margin-bottom:0;">Alle abgeschlossenen Online-Sessions</div></div>
      <a class="btn small secondary" href="${API}/zeitlog/export" target="_blank">CSV exportieren</a>
    </div>
    <div class="panel table-wrap">
      ${zeitlog.length ? `
      <table>
        <thead><tr><th>Datum</th><th>Gamertag</th><th>Start</th><th>Ende</th><th>Dauer (Std.)</th><th>Session</th></tr></thead>
        <tbody>${zeitlog.map((s) => `<tr>
          <td>${s.datum}</td><td>${escapeHtml(s.gamertag)}</td>
          <td>${fmtDate(s.start)}</td><td>${fmtDate(s.ende)}</td>
          <td>${fmtStd(s.dauer_std)}</td><td>${s.session_code || "–"}</td>
        </tr>`).join("")}</tbody>
      </table>` : `<div class="empty">Noch keine Sessions abgeschlossen.</div>`}
    </div>
  `;
}

// ---------- Leaderboard ----------

async function renderLeaderboard() {
  $app.innerHTML = `<div class="empty">Lade Rangliste …</div>`;
  const { leaderboard } = await api("/leaderboard");

  $app.innerHTML = `
    <h1>Zeit-Rangliste</h1>
    <div class="subtitle">Wer hat am meisten am Stadion gebaut?</div>
    <div class="panel table-wrap">
      ${leaderboard.length ? leaderboardTableHtml(leaderboard, true) : `<div class="empty">Noch keine Bauzeit erfasst.</div>`}
    </div>
  `;
}

function leaderboardTableHtml(rows, full = false) {
  return `<table>
    <thead><tr><th>Rang</th><th>Spieler</th><th>Std. gesamt</th>${full ? "<th>Sessions</th><th>Ø Session</th><th>Heute</th>" : ""}<th>Punkte</th><th>Status</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="rank-${r.rang}">
      <td class="rang-num">#${r.rang}</td>
      <td class="spieler-cell">${avatarHtml(r.avatar, 22)} ${escapeHtml(r.name)} <span style="color:var(--text-dim)">(${escapeHtml(r.gamertag)})</span> ${r.badge ? r.badge.icon : ""}</td>
      <td>${fmtStd(r.gesamt_std)}</td>
      ${full ? `<td>${r.sessions}</td><td>${fmtStd(r.avg_std)}</td><td>${fmtStd(r.heute_std)}</td>` : ""}
      <td>🪙 ${r.punkte}</td>
      <td><span class="online-dot ${r.status === "ON" ? "on" : ""}"></span>${r.status}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

// ---------- Statistik (Log + Profile) — ab bestimmtem Rang / Admin ----------

async function renderStatistik() {
  if (!(state.me.is_admin || state.me.kann_statistiken_sehen)) { $app.innerHTML = `<div class="empty">Kein Zugriff.</div>`; return; }
  $app.innerHTML = `<div class="empty">Lade Statistik …</div>`;
  const [{ log }, { profile }] = await Promise.all([api("/statistik/log"), api("/statistik/profile")]);

  $app.innerHTML = `
    <h1>Statistik</h1>
    <div class="subtitle">Aktivitätslog & Profile aller registrierten Spieler.</div>

    <div class="panel">
      <h2>Profile</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Konto-ID</th><th>Name</th><th>Gamertag</th><th>Rang</th><th>Std. gesamt</th><th>Punkte</th><th>Aufgaben erledigt</th><th>Status</th></tr></thead>
          <tbody>${profile.map((p) => `<tr>
            <td>${p.konto_id}</td><td class="spieler-cell">${avatarHtml(p.avatar, 20)} ${escapeHtml(p.vorname)} ${escapeHtml(p.nachname)}</td><td>${escapeHtml(p.gamertag)}</td>
            <td><span class="rank-chip" style="border-color:${p.rang_farbe};color:${p.rang_farbe}">${escapeHtml(p.rang)}</span></td>
            <td>${fmtStd(p.gesamt_std)}</td><td>🪙 ${p.punkte}</td><td>${p.aufgaben_erledigt}</td>
            <td>${p.aktiv ? "🟢 Aktiv" : "🔴 Gesperrt"}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h2>Aktivitätslog</h2>
      <div class="subtitle" style="margin-bottom:12px;">Wer war wann wie lange online und wie viele Aufgaben hat er in dieser Zeit erledigt.</div>
      <div class="table-wrap">
        ${log.length ? `<table>
          <thead><tr><th>Name</th><th>Datum</th><th>Von</th><th>Bis</th><th>Dauer (Std.)</th><th>Aufgaben erledigt</th></tr></thead>
          <tbody>${log.map((l) => `<tr>
            <td>${escapeHtml(l.name)} <span style="color:var(--text-dim)">(${escapeHtml(l.gamertag)})</span></td>
            <td>${l.datum}</td><td>${fmtDate(l.start)}</td><td>${fmtDate(l.ende)}</td>
            <td>${fmtStd(l.dauer_std)}</td><td>${l.aufgaben_erledigt}</td>
          </tr>`).join("")}</tbody>
        </table>` : `<div class="empty">Noch keine abgeschlossenen Sessions.</div>`}
      </div>
    </div>
  `;
}

// ---------- Admin ----------

async function renderAdmin() {
  if (!state.me.is_admin) { $app.innerHTML = `<div class="empty">Kein Zugriff.</div>`; return; }
  $app.innerHTML = `<div class="empty">Lade Verwaltung …</div>`;
  const [{ konten }, { ranks }] = await Promise.all([api("/admin/konten"), api("/ranks")]);
  const pending = konten.filter((k) => !k.freigegeben);
  const aktive = konten.filter((k) => k.freigegeben);

  $app.innerHTML = `
    <h1>Verwaltung</h1>
    <div class="subtitle">Konten freigeben, sperren, Ränge verteilen & verwalten.</div>

    ${pending.length ? `
    <div class="panel">
      <h2>⏳ Wartet auf Freigabe (${pending.length})</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Konto-ID</th><th>Name</th><th>Gamertag</th><th>Erstellt</th><th></th></tr></thead>
          <tbody>${pending.map((k) => `<tr>
            <td>${k.konto_id}</td><td>${escapeHtml(k.vorname)} ${escapeHtml(k.nachname)}</td><td>${escapeHtml(k.gamertag)}</td>
            <td>${fmtDate(k.erstellt)}</td>
            <td><button class="btn small" data-approve="${k.id}">Freigeben</button> <button class="btn small secondary" data-reject="${k.id}">Ablehnen</button></td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
    </div>` : ""}

    <div class="panel">
      <h2>Konten (${aktive.length})</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Konto-ID</th><th>Name</th><th>Gamertag</th><th>Punkte</th><th>Punkte buchen</th><th>Rang</th><th>Letzter Login</th><th>Status</th><th></th></tr></thead>
          <tbody>${aktive.map((k) => `<tr>
            <td>${k.konto_id}</td><td>${escapeHtml(k.vorname)} ${escapeHtml(k.nachname)}</td><td>${escapeHtml(k.gamertag)}</td>
            <td>🪙 ${k.punkte || 0}</td>
            <td>
              <div class="admin-points-control">
                <input type="number" step="1" class="num-input" data-points-input="${k.id}" placeholder="±Punkte" />
                <button class="btn small secondary" data-points-add="${k.id}">Buchen</button>
              </div>
            </td>
            <td>${k.is_admin ? `<span class="rank-chip" style="border-color:var(--yellow);color:var(--yellow)">Admin</span>` : `
              <select class="select-dark select-inline" data-rangwahl="${k.id}">
                ${ranks.map((r) => `<option value="${r.id}" ${r.id === k.rank_id ? "selected" : ""}>${escapeHtml(r.name)}</option>`).join("")}
              </select>`}</td>
            <td>${k.letzter_login ? fmtDate(k.letzter_login) : "–"}</td>
            <td>${k.aktiv ? "🟢 Aktiv" : "🔴 Gesperrt"}</td>
            <td>${k.is_admin ? "" : `<button class="btn small secondary" data-toggle="${k.id}">${k.aktiv ? "Sperren" : "Freigeben"}</button>`}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h2>Ränge & Berechtigungen</h2>
      <div class="subtitle" style="margin-bottom:12px;">„Sklave" ist immer der niedrigste Rang (Standard für neue Konten) und lässt sich nicht löschen.</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Rang</th><th>Stufe</th><th>Aufgaben zuweisen</th><th>Statistik/Log sehen</th><th>Kalender erstellen</th><th>Farbe</th><th></th></tr></thead>
          <tbody>${ranks.map((r) => `<tr data-rankrow="${r.id}">
            <td><span class="rank-chip" style="border-color:${r.farbe};color:${r.farbe}">${escapeHtml(r.name)}</span></td>
            <td>${r.name === "Sklave" ? "0" : `<input type="number" min="1" class="num-input" data-rf-level="${r.id}" value="${r.level}" />`}</td>
            <td><input type="checkbox" data-rf-assign="${r.id}" ${r.kann_aufgaben_zuweisen ? "checked" : ""} /></td>
            <td><input type="checkbox" data-rf-stats="${r.id}" ${r.kann_statistiken_sehen ? "checked" : ""} /></td>
            <td><input type="checkbox" data-rf-kalender="${r.id}" ${r.kann_kalender_erstellen ? "checked" : ""} /></td>
            <td><input type="color" data-rf-farbe="${r.id}" value="${r.farbe}" /></td>
            <td>${r.name === "Sklave" ? "" : `<button class="btn small secondary" data-rankdel="${r.id}">🗑</button>`}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
      <form id="rankForm" class="task-form" style="margin-top:16px;">
        <input type="text" name="name" placeholder="Neuer Rang, z. B. Vorarbeiter" required />
        <input type="number" name="level" min="1" placeholder="Stufe" value="1" style="width:90px;" required />
        <label class="check-label"><input type="checkbox" name="kann_aufgaben_zuweisen" /> Zuweisen</label>
        <label class="check-label"><input type="checkbox" name="kann_statistiken_sehen" /> Statistik</label>
        <label class="check-label"><input type="checkbox" name="kann_kalender_erstellen" /> Kalender</label>
        <input type="color" name="farbe" value="#f2c744" />
        <button class="btn small" type="submit">Rang anlegen</button>
      </form>
    </div>
  `;

  document.querySelectorAll("[data-toggle]").forEach((b) => b.onclick = async () => {
    await api(`/admin/konten/${b.dataset.toggle}/toggle`, { method: "POST" });
    renderAdmin();
  });
  document.querySelectorAll("[data-points-add]").forEach((b) => b.onclick = async () => {
    const input = document.querySelector(`[data-points-input="${b.dataset.pointsAdd}"]`);
    const punkte = Number(input?.value || 0);
    if (!Number.isInteger(punkte) || punkte === 0) return alert("Bitte eine ganze Zahl ungleich 0 eingeben (negativ zum Abziehen).");
    try { await api(`/admin/konten/${b.dataset.pointsAdd}/punkte`, { method: "POST", body: JSON.stringify({ punkte }) }); renderAdmin(); }
    catch (e) { alert(e.message); }
  });

  document.querySelectorAll("[data-approve]").forEach((b) => b.onclick = async () => {
    try { await api(`/admin/konten/${b.dataset.approve}/approve`, { method: "POST" }); renderAdmin(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-reject]").forEach((b) => b.onclick = async () => {
    if (!confirm("Diese Registrierung wirklich ablehnen und löschen?")) return;
    try { await api(`/admin/konten/${b.dataset.reject}/reject`, { method: "POST" }); renderAdmin(); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll("[data-rangwahl]").forEach((sel) => sel.onchange = async () => {
    try { await api(`/admin/konten/${sel.dataset.rangwahl}/rang`, { method: "POST", body: JSON.stringify({ rank_id: Number(sel.value) }) }); }
    catch (e) { alert(e.message); renderAdmin(); }
  });

  function collectRankPayload(id) {
    const row = document.querySelector(`[data-rankrow="${id}"]`);
    const levelEl = row.querySelector(`[data-rf-level="${id}"]`);
    return {
      level: levelEl ? Number(levelEl.value) : undefined,
      kann_aufgaben_zuweisen: row.querySelector(`[data-rf-assign="${id}"]`).checked,
      kann_statistiken_sehen: row.querySelector(`[data-rf-stats="${id}"]`).checked,
      kann_kalender_erstellen: row.querySelector(`[data-rf-kalender="${id}"]`).checked,
      farbe: row.querySelector(`[data-rf-farbe="${id}"]`).value,
    };
  }
  document.querySelectorAll("[data-rf-assign], [data-rf-stats], [data-rf-kalender], [data-rf-farbe], [data-rf-level]").forEach((el) => {
    el.onchange = async () => {
      const id = el.dataset.rfAssign || el.dataset.rfStats || el.dataset.rfKalender || el.dataset.rfFarbe || el.dataset.rfLevel;
      try { await api(`/ranks/${id}`, { method: "POST", body: JSON.stringify(collectRankPayload(id)) }); }
      catch (e) { alert(e.message); renderAdmin(); }
    };
  });
  document.querySelectorAll("[data-rankdel]").forEach((b) => b.onclick = async () => {
    if (!confirm("Diesen Rang wirklich löschen?")) return;
    try { await api(`/ranks/${b.dataset.rankdel}`, { method: "DELETE" }); renderAdmin(); }
    catch (e) { alert(e.message); }
  });
  document.getElementById("rankForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api("/ranks", {
        method: "POST",
        body: JSON.stringify({
          name: f.get("name"),
          level: Number(f.get("level")),
          kann_aufgaben_zuweisen: f.get("kann_aufgaben_zuweisen") === "on",
          kann_statistiken_sehen: f.get("kann_statistiken_sehen") === "on",
          kann_kalender_erstellen: f.get("kann_kalender_erstellen") === "on",
          farbe: f.get("farbe"),
        }),
      });
      renderAdmin();
    } catch (err) { alert(err.message); }
  };
}

function formatWorkTimer(item) {
  if (!item.start_zeit) return "00:00:00";
  const end = item.end_zeit ? new Date(item.end_zeit).getTime() : Date.now();
  const start = new Date(item.start_zeit).getTime();
  return fmtClock(Math.max(0, end - start));
}

// Aktualisiert alle laufenden Timer-Chips. Chips mit einem "erwartet"-Wert
// (Aufgaben/Layer mit erwarteter Zeit) zählen als Countdown runter — der bereits
// vor dem aktuellen Start verbrauchte Anteil wird per data-timer-verbraucht
// mit eingerechnet, damit Pause/Weiter nahtlos ineinander übergehen.
function refreshWorkTimers() {
  document.querySelectorAll("[data-timer-start]").forEach((el) => {
    const start = new Date(el.dataset.timerStart).getTime();
    const end = el.dataset.timerEnd ? new Date(el.dataset.timerEnd).getTime() : Date.now();
    if (el.dataset.timerErwartet) {
      const erwartet = Number(el.dataset.timerErwartet);
      const verbraucht = Number(el.dataset.timerVerbraucht || 0);
      const laufend = Math.max(0, (end - start) / 1000);
      const remaining = erwartet - verbraucht - laufend;
      el.textContent = `⏱ ${fmtCountdown(remaining)}`;
      el.classList.toggle("overtime", remaining < 0);
    } else {
      el.textContent = `⏱ ${fmtClock(Math.max(0, end - start))}`;
    }
  });
}

function startWorkTimerTicker() {
  if (state.workTimerHandle) clearInterval(state.workTimerHandle);
  if (!document.querySelector("[data-timer-start]")) return;
  refreshWorkTimers();
  state.workTimerHandle = setInterval(refreshWorkTimers, 1000);
}

// ---------- Utils ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const extraUiStyle = document.createElement("style");
extraUiStyle.textContent = `
.dashboard-task-link { cursor:pointer; transition:transform .15s ease, border-color .15s ease; }
.dashboard-task-link:hover { transform:translateY(-1px); border-color:var(--yellow); }
.work-timer { margin-left:auto; padding:6px 10px; border-radius:10px; background:rgba(242,199,68,.12); color:var(--yellow); font-weight:700; font-variant-numeric:tabular-nums; white-space:nowrap; }
.work-timer.overtime { background: rgba(220,80,80,.18); color:#ff6b6b; }
.work-timer.paused { background: rgba(255,255,255,.08); color: var(--text-dim,#aaa); }
.admin-points-control { display:flex; gap:6px; margin-top:6px; }
.admin-points-control .num-input { width:90px; height:32px; }
.reassign-box { flex-basis:100%; display:flex; flex-direction:column; align-items:flex-start; gap:6px; margin-top:8px; }
.reassign-box .assignment-picker { width:100%; max-width:380px; }
.plan-panel { line-height:1.55; }
.plan-title { color:#2e9e4d; text-align:center; font-size:1.9em; text-decoration:underline; margin:6px 0 18px; }
.plan-day { color:#d9534f; text-align:center; font-size:1.2em; margin:22px 0 10px; }
.plan-time { color:#b485e0; text-align:center; font-weight:800; margin:14px 0 8px; }
.plan-note { color:#d9a441; text-align:center; font-style:italic; margin:8px 0; }
.plan-alert { color:#2e9e4d; text-align:center; font-weight:800; margin:10px 0; }
.plan-line { margin:4px 0; }
.plan-space { height:6px; }
#planEditArea { color:var(--text,#fff); }
.mini-stats-row { display:flex; flex-wrap:wrap; gap:8px 18px; align-items:center; margin:4px 0 16px; padding:8px 14px; background:var(--panel,#17191d); border:1px solid var(--border,#333); border-radius:10px; }
.mini-stat { font-size:.85em; color:var(--text-dim,#aaa); white-space:nowrap; }
.mini-stat strong { color:var(--text,#fff); font-variant-numeric:tabular-nums; }
`;
document.head.appendChild(extraUiStyle);

boot();
