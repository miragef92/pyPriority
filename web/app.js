import { Store, IDBAdapter, ValidationError, NotFound } from "./store.js";
import { Google } from "./google.js";
import { Sync } from "./sync.js";
import { CalendarService } from "./calendar.js";

const APP_VERSION = "1.1.0";

const QUADS = {
  1: { name: "Urgent et important", hint: "Faire", color: "var(--q1)", hex: "#E24B4A" },
  2: { name: "Important, pas urgent", hint: "Planifier", color: "var(--q2)", hex: "#378ADD" },
  3: { name: "Urgent, pas important", hint: "Déléguer / expédier", color: "var(--q3)", hex: "#EF9F27" },
  4: { name: "Ni urgent ni important", hint: "Plus tard", color: "var(--q4)", hex: "#888780" },
};
const PALETTE = ["#7F77DD", "#1D9E75", "#D85A30", "#D4537E", "#378ADD", "#639922", "#BA7517", "#888780"];
const SNAP = 15;
const EVENT_LABELS = {
  created: "Créée", done: "Terminée", reopened: "Rouverte", planned: "Planifiée", unplanned: "Retirée du planning",
  reported: "Reportée (non faite le", quadrant: "Quadrant", renamed: "Renommée (ancien titre :", deleted: "Mise à la corbeille", restored: "Restaurée",
};

let S = { projects: [], tasks: [], today: "", settings: {}, trash_count: 0 };
const ui = {
  view: localGet("view", "matrix"), project: null, showDone: false, search: "",
  openTask: null, focus: null, mode: localGet("dayMode", "1"), customN: +localGet("customN", "5") || 5, miniMonth: null,
  eventsByDate: {}, calWarning: null, eventsKey: null,
};

// ---------------------------------------------------------------- utilitaires
function localGet(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function localSet(k, v) { try { v === "" || v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function toast(msg, { error = false, undo = null, ms = 5000 } = {}) {
  const t = document.createElement("div");
  t.className = "toast" + (error ? " error" : "");
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (undo) {
    const b = document.createElement("button");
    b.textContent = "Annuler";
    b.onclick = async () => { t.remove(); try { await undo(); await load(); } catch {} };
    t.appendChild(b);
  }
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), undo ? Math.max(ms, 8000) : ms);
}

// ---------------------------------------------------------------- données locales
class ApiError extends Error {}
let store, google, sync, calendar;

async function api(method, path, body) {
  try {
    return await store.api(method, path, body);
  } catch (e) {
    const known = e instanceof ValidationError || e instanceof NotFound;
    if (!known) console.error(e);
    const msg = known ? e.message : `Erreur : ${e?.message || e}`;
    toast(msg, { error: true });
    throw new ApiError(msg);
  }
}
window.addEventListener("unhandledrejection", e => {
  if (!(e.reason instanceof ApiError)) { console.error(e.reason); toast("Erreur inattendue : " + (e.reason?.message || e.reason), { error: true }); }
  e.preventDefault();
});

async function load() {
  S = await api("GET", "state");
  if (!ui.focus) ui.focus = S.today;
  if (ui.project != null && !S.projects.some(p => p.id === ui.project)) ui.project = null;
  render();
}

// ---------------------------------------------------------------- dates
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseISO = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
function dayLabel(s, long) {
  if (!s) return "";
  const diff = Math.round((parseISO(s) - parseISO(S.today)) / 864e5);
  if (!long) { if (diff === 0) return "aujourd'hui"; if (diff === 1) return "demain"; if (diff === -1) return "hier"; }
  return parseISO(s).toLocaleDateString("fr-FR", long
    ? { weekday: "long", day: "numeric", month: "long", year: parseISO(s).getFullYear() === parseISO(S.today).getFullYear() ? undefined : "numeric" }
    : { weekday: "short", day: "numeric", month: "short" });
}
const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? String(m % 60).padStart(2, "0") : ""}` : `${m} min`;
const toMin = hhmm => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const fromMin = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const timeLabel = s => new Date(s).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const stampLabel = s => `${dayLabel(s.slice(0, 10))} ${timeLabel(s)}`;

// ---------------------------------------------------------------- saisie rapide
function parseQuick(text) {
  const out = {};
  text = text.replace(/(^|\s)!([1-4])(?=\s|$)/, (_, a, q) => { out.quadrant = +q; return a; });
  text = text.replace(/(^|\s)~(\d+)h(\d*)(?=\s|$)/i, (_, a, h, m) => { out.estimate = +h * 60 + (+m || 0); return a; });
  text = text.replace(/(^|\s)~(\d+)(m|min)?(?=\s|$)/i, (_, a, m) => { out.estimate = +m; return a; });
  text = text.replace(/(^|\s)@(\S+)/, (all, a, w) => { const d = parseDateWord(w); if (!d) return all; out.due = d; return a; });
  text = text.replace(/(^|\s)#(\S+)/, (_, a, p) => { out.projectName = p; return a; });
  if (out.estimate !== undefined) out.estimate = Math.min(1440, Math.max(5, out.estimate));
  out.title = text.replace(/\s+/g, " ").trim();
  return out;
}
function parseDateWord(w) {
  w = norm(w);
  if (["auj", "aujourdhui", "aujourd'hui", "today"].includes(w)) return S.today;
  if (w === "demain") return addDays(S.today, 1);
  if (w === "apres-demain") return addDays(S.today, 2);
  const wd = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"].findIndex(j => w.startsWith(j));
  if (wd >= 0) return addDays(S.today, (wd - parseISO(S.today).getDay() + 7) % 7 || 7);
  if (/^\d{4}-\d{2}-\d{2}$/.test(w) && !isNaN(parseISO(w))) return w;
  const m = w.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    let y = m[3] ? +m[3] : parseISO(S.today).getFullYear(); if (y < 100) y += 2000;
    const d = new Date(y, +m[2] - 1, +m[1]);
    if (d.getMonth() !== +m[2] - 1) return null; // 31/02 etc.
    if (!m[3] && iso(d) < S.today) d.setFullYear(y + 1);
    return iso(d);
  }
  return null;
}
async function projectIdFor(name) {
  if (!name) return ui.project;
  const n = norm(name);
  const p = S.projects.find(p => norm(p.name) === n) || S.projects.find(p => norm(p.name).startsWith(n));
  if (p) return p.id;
  const r = await api("POST", "projects", { name, color: PALETTE[S.projects.length % PALETTE.length] });
  toast(`Projet « ${name} » créé`);
  return r.id;
}
async function createTask(text, extra = {}) {
  const q = parseQuick(text);
  if (!q.title) { toast("Le titre de la tâche est vide.", { error: true }); return false; }
  const body = { title: q.title, quadrant: q.quadrant ?? extra.quadrant ?? 2, project_id: await projectIdFor(q.projectName) };
  if (q.estimate) body.estimate = q.estimate;
  if (q.due) body.due = q.due;
  if (extra.planned_date) body.planned_date = extra.planned_date;
  await api("POST", "tasks", body);
  await load();
  return true;
}
function bindAddInput(input, extra) {
  input.addEventListener("keydown", async e => {
    if (e.key !== "Enter" || !input.value.trim() || input.dataset.busy) return;
    input.dataset.busy = 1;
    const v = input.value;
    try { if (await createTask(v, extra())) input.value = ""; } catch {} // le texte reste si l'enregistrement échoue
    finally { delete input.dataset.busy; }
  });
}

// ---------------------------------------------------------------- éléments communs
const project = id => S.projects.find(p => p.id === id);
const findTask = id => S.tasks.find(t => t.id === id);
function visibleTasks() {
  const q = norm(ui.search.trim());
  return S.tasks.filter(t => (ui.showDone || !t.done) && (ui.project == null || t.project_id === ui.project)
    && (!q || norm(t.title + " " + (project(t.project_id)?.name || "")).includes(q)));
}
function taskMeta(t, opts = {}) {
  const p = project(t.project_id), bits = [];
  if (p && ui.project == null) bits.push(`<span><i class="dot" style="background:${p.color}"></i>${esc(p.name)}</span>`);
  if (t.due) {
    const late = !t.done && t.due < S.today, today = t.due === S.today;
    bits.push(`<span class="${late || today ? "badge " + (late ? "danger" : "warn") : ""}">⚑ ${dayLabel(t.due)}</span>`);
  }
  if (!opts.hidePlan && t.planned_date && !t.done)
    bits.push(`<span class="badge info">◷ ${dayLabel(t.planned_date)}${t.planned_start ? " " + t.planned_start : ""}</span>`);
  bits.push(`<span>${fmtMin(t.estimate)}</span>`);
  if (t.subtasks?.length) bits.push(`<span>☑ ${t.subtasks.filter(s => s.done).length}/${t.subtasks.length}</span>`);
  if (t.note_count) bits.push(`<span>✎ ${t.note_count}</span>`);
  if (t.reports && !t.done) bits.push(`<span class="badge warn">reportée ${t.reports}×</span>`);
  return `<div class="meta">${bits.join("")}</div>`;
}
function taskCard(t, opts = {}) {
  return `<div class="task ${t.done ? "done" : ""} ${ui.openTask === t.id ? "selected" : ""}" draggable="true" data-id="${t.id}">
    ${opts.bar ? `<span class="qbar" style="background:${QUADS[t.quadrant].color}"></span>` : ""}
    <input type="checkbox" class="check" ${t.done ? "checked" : ""} title="${t.done ? "Rouvrir" : "Terminer"}" aria-label="Terminer">
    <div class="body"><div class="title">${esc(t.title)}</div>${taskMeta(t, opts)}</div></div>`;
}
const drag = { id: null, ev: null, offset: 0 };
function bindTaskCards(root) {
  $$(".task", root).forEach(el => {
    const id = el.dataset.id;
    el.addEventListener("click", e => { if (!e.target.classList.contains("check")) openTask(id); });
    el.querySelector(".check").addEventListener("change", e => setDone(id, e.target.checked));
    el.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", String(id)); e.dataTransfer.effectAllowed = "move"; el.classList.add("dragging"); drag.id = id; drag.offset = 0; });
    el.addEventListener("dragend", () => { el.classList.remove("dragging"); drag.id = null; clearDropMarks(); });
  });
}
function clearDropMarks() {
  $$(".drop-hover").forEach(e => e.classList.remove("drop-hover"));
  $$(".drop-line, .ghost-block").forEach(e => e.remove());
}
async function setDone(id, done) {
  await api("PATCH", `tasks/${id}`, { done: done ? 1 : 0 });
  await load();
  if (done) toast(`« ${findTask(id)?.title ?? "Tâche"} » terminée`, { undo: () => api("PATCH", `tasks/${id}`, { done: 0 }) });
}
async function patchTask(id, body) {
  try { await api("PATCH", `tasks/${id}`, body); } finally { await load().catch(() => {}); }
}
async function deleteTask(id) {
  const t = findTask(id);
  await api("DELETE", `tasks/${id}`);
  if (ui.openTask === id) closeDrawer();
  await load();
  toast(`« ${t?.title ?? "Tâche"} » mise à la corbeille`, { undo: () => api("POST", `tasks/${id}/restore`, {}) });
}

// ---------------------------------------------------------------- rendu
function render() {
  $$(".nav[data-view]").forEach(n => n.classList.toggle("active", n.dataset.view === ui.view));
  $$(".mobile-nav [data-view]").forEach(b => b.classList.toggle("on", b.dataset.view === ui.view));
  ["matrix", "day", "notes", "trash"].forEach(v => $("#view-" + v).classList.toggle("hidden", v !== ui.view));
  const open = S.tasks.filter(t => !t.done);
  $("#c-matrix").textContent = open.length || "";
  $("#c-day").textContent = open.filter(t => t.planned_date === S.today).length || "";
  $("#c-trash").textContent = S.trash_count || "";
  renderProjects();
  ({ matrix: renderMatrix, day: renderDay, notes: renderNotes, trash: renderTrash })[ui.view]?.();
  if (ui.openTask) renderDrawer();
}

function renderProjects() {
  const counts = {};
  S.tasks.forEach(t => { if (!t.done) counts[t.project_id] = (counts[t.project_id] || 0) + 1; });
  $("#projects").innerHTML = `<div class="nav ${ui.project == null ? "active" : ""}" data-pid="" tabindex="0">Tous les projets</div>` +
    S.projects.map(p => `<div class="nav ${ui.project === p.id ? "active" : ""}" data-pid="${p.id}" tabindex="0">
      <i class="dot" style="background:${p.color}"></i><span class="pname">${esc(p.name)}</span>
      <span class="count">${counts[p.id] || ""}</span><button class="ghost proj-menu" title="Modifier le projet" aria-label="Modifier le projet">⋯</button></div>`).join("");
  $$("#projects .nav").forEach(n => {
    const pid = n.dataset.pid || null;
    n.addEventListener("click", e => {
      if (e.target.classList.contains("proj-menu")) return projectModal(project(pid));
      ui.project = ui.project === pid ? null : pid; render();
    });
    if (pid != null) {
      n.addEventListener("dragover", e => { if (drag.id) { e.preventDefault(); n.classList.add("drop-hover"); } });
      n.addEventListener("dragleave", () => n.classList.remove("drop-hover"));
      n.addEventListener("drop", e => { e.preventDefault(); const id = drag.id; clearDropMarks(); patchTask(id, { project_id: pid }); });
    }
  });
}

// ---------------------------------------------------------------- matrice
function renderMatrix() {
  const tasks = visibleTasks();
  $("#matrix").innerHTML = [1, 2, 3, 4].map(q => {
    const list = tasks.filter(t => t.quadrant === q).sort((a, b) => a.done - b.done || a.sort - b.sort);
    return `<section class="quad" data-q="${q}" style="border-top-color:${QUADS[q].color}">
      <header><b>${QUADS[q].name}</b><span class="faint small">${list.filter(t => !t.done).length}</span><span class="hint">${QUADS[q].hint}</span></header>
      <div class="list">${list.map(t => taskCard(t)).join("") || `<div class="empty">${ui.search ? "Aucun résultat" : "Glisse une tâche ici"}</div>`}</div>
      <input class="add" placeholder="+ Ajouter ici" data-q="${q}" maxlength="500"></section>`;
  }).join("");
  bindTaskCards($("#matrix"));
  $$("#matrix .quad").forEach(quad => {
    const q = +quad.dataset.q, list = quad.querySelector(".list");
    bindAddInput(quad.querySelector(".add"), () => ({ quadrant: q }));
    quad.addEventListener("dragover", e => {
      if (!drag.id) return; e.preventDefault();
      quad.classList.add("drop-hover");
      const after = cardAfter(list, e.clientY);
      let line = $(".drop-line"); if (!line) { line = document.createElement("div"); line.className = "drop-line"; }
      after ? list.insertBefore(line, after) : list.appendChild(line);
    });
    quad.addEventListener("dragleave", e => { if (!quad.contains(e.relatedTarget)) { quad.classList.remove("drop-hover"); $(".drop-line")?.remove(); } });
    quad.addEventListener("drop", e => {
      e.preventDefault();
      const id = drag.id; if (!id) return;
      const cards = $$(".task:not(.dragging)", list), after = cardAfter(list, e.clientY);
      const idx = after ? cards.indexOf(after) : cards.length;
      const sortOf = el => findTask(el.dataset.id).sort;
      const prev = cards[idx - 1] ? sortOf(cards[idx - 1]) : null, next = cards[idx] ? sortOf(cards[idx]) : null;
      const sort = prev == null && next == null ? Date.now() / 1000 : prev == null ? next - 1 : next == null ? prev + 1 : (prev + next) / 2;
      clearDropMarks(); patchTask(id, { quadrant: q, sort });
    });
  });
}
function cardAfter(list, y) {
  return $$(".task:not(.dragging)", list).find(el => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
}

// ---------------------------------------------------------------- planning (1 à 14 jours)
const MAX_DAYS = 14;
const MODES = [["1", "Jour"], ["3", "3 jours"], ["7", "Semaine"]];
let dayRange = [7, 21];
const hourPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour"));
const weekStart = d => addDays(d, -((parseISO(d).getDay() + 6) % 7));

function visibleDays() {
  const n = ui.mode === "custom" ? ui.customN : +ui.mode;
  const start = ui.mode === "7" ? weekStart(ui.focus) : ui.focus;
  return Array.from({ length: n }, (_, i) => addDays(start, i));
}
function setMode(mode, customN) {
  ui.mode = mode;
  if (customN) ui.customN = customN;
  localSet("dayMode", mode); localSet("customN", String(ui.customN));
  renderDay();
}
function goTo(date) { ui.focus = date; ui.miniMonth = null; renderDay(); }
function shiftDays(dir) { goTo(addDays(ui.focus, dir * visibleDays().length)); }
function rangeTitle(days) {
  if (days.length === 1) return days[0] === S.today ? `Aujourd'hui, ${dayLabel(days[0], true)}` : cap(dayLabel(days[0], true));
  const a = parseISO(days[0]), b = parseISO(days.at(-1));
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  const fa = a.toLocaleDateString("fr-FR", sameMonth ? { day: "numeric" } : { day: "numeric", month: "short", year: a.getFullYear() === b.getFullYear() ? undefined : "numeric" });
  return `${fa} – ${b.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}`;
}

const calKey = () => (google.enabled() ? "g" : "-") + (S.settings.calendars || "");
async function loadEvents(days) {
  const key = days[0] + "|" + days.length + "|" + calKey();
  ui.eventsKey = key;
  if (!google.enabled()) { ui.eventsByDate = {}; ui.calWarning = null; return; }
  const r = await api("GET", `calendar?date=${days[0]}&days=${days.length}`);
  if (ui.eventsKey !== key) return; // l'affichage a changé entre-temps
  ui.calWarning = r.warning;
  ui.eventsByDate = Object.fromEntries(r.days.map(d => [d.date, d.events]));
}

function chipHTML(t) {
  const p = project(t.project_id);
  return `<div class="task chip ${t.done ? "done" : ""}" draggable="true" data-id="${t.id}" style="border-left-color:${p ? p.color : QUADS[t.quadrant].hex}" title="${esc(t.title)}">
    <input type="checkbox" class="check" ${t.done ? "checked" : ""} aria-label="Terminer"><div class="body"><div class="title">${esc(t.title)}</div></div></div>`;
}
function blockHTML(it, top0, pxMin) {
  const top = (it.start - top0) * pxMin, h = Math.max(18, (it.end - it.start) * pxMin - 2);
  const pos = `top:${top}px;height:${h}px;left:calc(${it.lane / it.lanes * 100}% + 2px);width:calc(${100 / it.lanes}% - 4px)`;
  if (it.kind === "event") {
    const e = it.e, edit = e.canEdit && e.id;
    return `<div class="block event ${e.id ? "clickable" : ""}" ${evAttrs(e)} style="${pos}" title="${esc(e.title)} · ${e.start}">
      <div><div class="bt">${esc(e.title)}</div><div>${e.start} · ${fmtMin(e.minutes)}</div></div>${edit && !e.split ? `<div class="resize" title="Tirer pour changer la durée"></div>` : ""}</div>`;
  }
  const t = it.t, p = project(t.project_id);
  return `<div class="block task-b ${t.done ? "done" : ""}" draggable="true" data-id="${t.id}" style="${pos};background:${p ? p.color : QUADS[t.quadrant].hex}" title="${esc(t.title)} · ${t.planned_start}–${fromMin(it.end)}">
    <input type="checkbox" class="check" ${t.done ? "checked" : ""} aria-label="Terminer"><div><div class="bt">${esc(t.title)}</div><div>${t.planned_start}–${fromMin(it.end)}${t.note_count ? " · ✎ " + t.note_count : ""}</div></div><div class="resize" title="Tirer pour changer la durée"></div></div>`;
}

function renderDay() {
  const days = visibleDays();
  if (ui.eventsKey !== days[0] + "|" + days.length + "|" + calKey()) {
    ui.eventsByDate = {};
    loadEvents(days).then(() => ui.view === "day" && renderDay()).catch(() => {});
  }
  const tasks = visibleTasks();
  const carried = tasks.filter(t => !t.done && t.carried_from && !t.planned_date);
  const todo = tasks.filter(t => !t.done && !t.planned_date && !t.carried_from).sort((a, b) => a.quadrant - b.quadrant || a.sort - b.sort);
  evIndex.clear();
  const perDay = days.map(d => {
    const evs = ui.eventsByDate[d] || [];
    for (const e of evs) if (e.id) evIndex.set(evKey(e), e);
    const planned = tasks.filter(t => t.planned_date === d && t.planned_start);
    const noTime = tasks.filter(t => t.planned_date === d && !t.planned_start);
    const items = [
      ...evs.filter(e => !e.allday).map(e => ({ kind: "event", start: toMin(e.start), end: Math.min(1440, toMin(e.start) + e.minutes), e })),
      ...planned.map(t => ({ kind: "task", start: toMin(t.planned_start), end: Math.min(1440, toMin(t.planned_start) + t.estimate), t })),
    ];
    layoutLanes(items);
    return {
      d, items, noTime, allday: evs.filter(e => e.allday),
      taskMin: [...planned, ...noTime].filter(t => !t.done).reduce((s, t) => s + t.estimate, 0),
      meetMin: evs.filter(e => !e.allday).reduce((s, e) => s + e.minutes, 0),
    };
  });
  // plage horaire : paramètres, élargie si des éléments débordent
  let h0 = +(S.settings.day_start || 7), h1 = +(S.settings.day_end || 21);
  perDay.forEach(p => p.items.forEach(it => { h0 = Math.min(h0, Math.floor(it.start / 60)); h1 = Math.max(h1, Math.ceil(it.end / 60)); }));
  dayRange = [h0, h1];
  const pxMin = hourPx() / 60, top0 = h0 * 60, n = days.length;
  const totTask = perDay.reduce((s, p) => s + p.taskMin, 0), totMeet = perDay.reduce((s, p) => s + p.meetMin, 0);
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const hours = []; for (let h = h0; h < h1; h++) hours.push(`<span style="top:${(h - h0) * hourPx()}px">${h}:00</span>`);

  $("#view-day").innerHTML = `
    <div class="dayhead">
      <button id="d-today" title="Aujourd'hui (T)">Aujourd'hui</button>
      <button id="d-prev" title="Précédent (←)" aria-label="Période précédente">‹</button>
      <button id="d-next" title="Suivant (→)" aria-label="Période suivante">›</button>
      <h2>${rangeTitle(days)}</h2>
      <div class="seg" role="group" aria-label="Nombre de jours">
        ${MODES.map(([m, l]) => `<button data-mode="${m}" class="${ui.mode === m ? "on" : ""}">${l}</button>`).join("")}
        ${ui.mode === "custom" ? `<button data-mode="custom" class="on">${ui.customN} jours</button>` : ""}
      </div>
      <span class="stats">${fmtMin(totTask)} de tâches · ${fmtMin(totMeet)} de réunions${google.enabled() ? "" : ` · <a href="#" id="link-settings">connecter Google Agenda</a>`}</span>
    </div>
    ${ui.calWarning ? `<div class="badge danger cal-warning">${esc(ui.calWarning)}</div>` : ""}
    <div class="day">
      <div class="backlog">
        <div class="mini" id="mini"></div>
        ${carried.length ? `<div class="group"><span>Reportées</span><span>${carried.length}</span></div>${carried.map(t => taskCard(t, { bar: true })).join("")}` : ""}
        <div class="group"><span>À planifier</span><span>${todo.length}</span></div>
        <div class="zone" id="zone-backlog">${todo.map(t => taskCard(t, { bar: true })).join("") || `<div class="empty">Rien en attente</div>`}</div>
      </div>
      <div class="cal" style="--n:${n}">
        <div class="cal-row cal-head"><div></div>
          ${perDay.map(p => `<button class="dh ${p.d === S.today ? "today" : ""} ${p.d < S.today ? "past" : ""}" data-date="${p.d}" title="Afficher ce jour seul">
            <span class="dn">${parseISO(p.d).toLocaleDateString("fr-FR", { weekday: "short" })}</span><span class="dd">${parseISO(p.d).getDate()}</span>
            ${p.taskMin || p.meetMin ? `<span class="dl">${p.taskMin ? fmtMin(p.taskMin) : ""}${p.taskMin && p.meetMin ? " · " : ""}${p.meetMin ? `<span class="faint">${fmtMin(p.meetMin)}</span>` : ""}</span>` : ""}</button>`).join("")}
        </div>
        <div class="cal-row cal-allday"><div class="corner">sans<br>horaire</div>
          ${perDay.map(p => `<div class="ad ${p.d < S.today ? "past" : ""}" data-date="${p.d}">${p.allday.map(e => `<div class="ev-chip ${e.id ? "clickable" : ""}" ${evAttrs(e)} title="${esc(e.title)}">${esc(e.title)}</div>`).join("")}${p.noTime.map(chipHTML).join("")}</div>`).join("")}
        </div>
        <div class="cal-row cal-body" style="height:${(h1 - h0) * hourPx()}px">
          <div class="hours">${hours.join("")}</div>
          ${perDay.map(p => `<div class="col ${p.d === S.today ? "today" : ""} ${p.d < S.today ? "past" : ""}" data-date="${p.d}">${p.items.map(it => blockHTML(it, top0, pxMin)).join("")}
            ${p.d === S.today && nowMin >= top0 && nowMin <= h1 * 60 ? `<div class="nowline" style="top:${(nowMin - top0) * pxMin}px"></div>` : ""}</div>`).join("")}
        </div>
      </div>
    </div>`;

  $("#d-prev").onclick = () => shiftDays(-1);
  $("#d-next").onclick = () => shiftDays(1);
  $("#d-today").onclick = () => goTo(S.today);
  $$(".seg button").forEach(b => b.onclick = () => b.dataset.mode !== "custom" && setMode(b.dataset.mode));
  $$(".dh").forEach(b => b.onclick = () => { ui.focus = b.dataset.date; setMode("1"); });
  $("#link-settings")?.addEventListener("click", e => { e.preventDefault(); openSettings(); });
  bindTaskCards($("#view-day .backlog"));
  bindTaskCards($("#view-day .cal-allday"));
  renderMini(days);
  bindDayDnD();
}

// mini-calendrier : clic = aller au jour, glisser = afficher plusieurs jours
let miniSel = null;
function renderMini(days) {
  const box = $("#mini");
  if (!box) return;
  if (!ui.miniMonth) ui.miniMonth = days[0].slice(0, 8) + "01";
  const month = parseISO(ui.miniMonth), start = weekStart(ui.miniMonth);
  const [a, b] = miniSel ? [miniSel.a, miniSel.b].sort() : [days[0], days.at(-1)];
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  box.innerHTML = `<div class="mini-head"><button class="ghost" data-m="-1" aria-label="Mois précédent">‹</button>
      <span>${cap(month.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }))}</span>
      <button class="ghost" data-m="1" aria-label="Mois suivant">›</button></div>
    <div class="mini-grid">${["L", "M", "M", "J", "V", "S", "D"].map(d => `<span class="wd">${d}</span>`).join("")}
      ${cells.map(d => `<button class="md ${parseISO(d).getMonth() !== month.getMonth() ? "out" : ""} ${d === S.today ? "today" : ""} ${d >= a && d <= b ? "sel" : ""}" data-date="${d}">${parseISO(d).getDate()}</button>`).join("")}</div>
    <div class="small faint mini-hint">Glisse sur plusieurs jours pour les afficher ensemble</div>`;
  $$(".mini-head button", box).forEach(btn => btn.onclick = () => {
    const m = parseISO(ui.miniMonth); m.setMonth(m.getMonth() + +btn.dataset.m); ui.miniMonth = iso(m); renderMini(visibleDays());
  });
  $(".mini-grid", box).addEventListener("pointerdown", e => {
    const cell = e.target.closest(".md"); if (!cell) return;
    e.preventDefault();
    miniSel = { a: cell.dataset.date, b: cell.dataset.date };
    renderMini(visibleDays());
  });
}
window.addEventListener("pointermove", e => {
  if (!miniSel) return;
  const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".md");
  if (cell && cell.dataset.date !== miniSel.b) {
    const span = Math.round((parseISO(cell.dataset.date) - parseISO(miniSel.a)) / 864e5);
    if (Math.abs(span) < MAX_DAYS) { miniSel.b = cell.dataset.date; renderMini(visibleDays()); }
  }
});
window.addEventListener("pointerup", () => {
  if (!miniSel) return;
  const [a, b] = [miniSel.a, miniSel.b].sort();
  miniSel = null;
  const n = Math.round((parseISO(b) - parseISO(a)) / 864e5) + 1;
  ui.focus = a;
  if (n === 1) {
    if (ui.mode === "7") ui.miniMonth = null;
    renderDay();
  } else setMode(n === 3 ? "3" : "custom", n === 3 ? undefined : n);
});

function layoutLanes(items) {
  items.sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster = [], clusterEnd = -1, lanes = [];
  const flush = () => { cluster.forEach(i => i.lanes = lanes.length); cluster = []; lanes = []; };
  for (const it of items) {
    if (it.start >= clusterEnd) { flush(); clusterEnd = -1; }
    let lane = lanes.findIndex(end => end <= it.start);
    if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = it.end; it.lane = lane; cluster.push(it); clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
}
function minuteAt(col, clientY) {
  const r = col.getBoundingClientRect(), [h0, h1] = dayRange;
  const m = h0 * 60 + (clientY - r.top) / (hourPx() / 60);
  return Math.max(h0 * 60, Math.min(h1 * 60 - SNAP, Math.round(m / SNAP) * SNAP));
}
function bindDropZone(z, body) {
  z.addEventListener("dragover", e => { if (drag.id) { e.preventDefault(); z.classList.add("drop-hover"); } });
  z.addEventListener("dragleave", e => { if (!z.contains(e.relatedTarget)) z.classList.remove("drop-hover"); });
  z.addEventListener("drop", e => { e.preventDefault(); const id = drag.id; if (!id) return; clearDropMarks(); patchTask(id, body()); });
}
function bindDayDnD() {
  $$(".cal .block.task-b").forEach(b => {
    const id = b.dataset.id;
    b.addEventListener("click", e => { if (!e.target.classList.contains("check") && !e.target.classList.contains("resize")) openTask(id); });
    b.querySelector(".check").addEventListener("change", e => setDone(id, e.target.checked));
    b.addEventListener("dragstart", e => {
      if (resizing) return e.preventDefault();
      e.dataTransfer.setData("text/plain", String(id)); drag.id = id; drag.offset = e.clientY - b.getBoundingClientRect().top;
      setTimeout(() => b.style.opacity = .3);
    });
    b.addEventListener("dragend", () => { b.style.opacity = ""; drag.id = null; drag.offset = 0; clearDropMarks(); });
    b.querySelector(".resize").addEventListener("pointerdown", e => startResize(e, b, id));
  });
  bindEventBlocks();
  // Tâches : pas de dépôt sur les jours passés (elles seraient aussitôt « reportées »). Événements : partout.
  $$(".cal .col").forEach(col => {
    const past = col.classList.contains("past");
    col.addEventListener("dragover", e => {
      const ev = drag.ev && !drag.ev.allday ? drag.ev : null;
      if (!(drag.id && !past) && !ev) return;
      e.preventDefault();
      const m = minuteAt(col, e.clientY - drag.offset), pxMin = hourPx() / 60;
      const t = drag.id ? findTask(drag.id) : null;
      const minutes = t ? t.estimate : Math.round((new Date(ev.e) - new Date(ev.s)) / 60e3);
      let g = $(".ghost-block");
      if (g && g.parentNode !== col) { g.remove(); g = null; }
      if (!g) { g = document.createElement("div"); g.className = "ghost-block"; col.appendChild(g); }
      g.style.top = (m - dayRange[0] * 60) * pxMin + "px"; g.style.height = Math.max(18, minutes * pxMin - 2) + "px";
      g.textContent = `${fromMin(m)}  ${t ? t.title : ev.title}`;
    });
    col.addEventListener("dragleave", e => { if (!col.contains(e.relatedTarget)) col.querySelector(".ghost-block")?.remove(); });
    col.addEventListener("drop", e => {
      e.preventDefault();
      const m = minuteAt(col, e.clientY - drag.offset), id = drag.id, ev = drag.ev;
      clearDropMarks();
      if (id && !past) patchTask(id, { planned_date: col.dataset.date, planned_start: fromMin(m) });
      else if (ev && !ev.allday) moveEvent(ev, col.dataset.date, m);
    });
  });
  $$(".cal .ad").forEach(z => {
    if (!z.classList.contains("past")) bindDropZone(z, () => ({ planned_date: z.dataset.date, planned_start: null }));
    z.addEventListener("dragover", e => { if (drag.ev?.allday) { e.preventDefault(); z.classList.add("drop-hover"); } });
    z.addEventListener("drop", e => {
      if (!drag.ev?.allday) return;
      e.preventDefault(); const ev = drag.ev; clearDropMarks(); shiftAllDayEvent(ev, z.dataset.date);
    });
  });
  bindDropZone($("#zone-backlog"), () => ({ planned_date: null }));
}
let resizing = false;
function startResize(e, block, id) {
  e.preventDefault(); e.stopPropagation(); resizing = true; block.draggable = false;
  const t = findTask(id), startY = e.clientY, startH = block.offsetHeight, pxMin = hourPx() / 60;
  let est = t.estimate;
  const move = ev => { est = Math.min(1440, Math.max(SNAP, Math.round((startH + ev.clientY - startY) / pxMin / SNAP) * SNAP)); block.style.height = est * pxMin - 2 + "px"; };
  const up = () => {
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); resizing = false;
    if (est !== t.estimate) patchTask(id, { estimate: est }); else block.draggable = true;
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}

// ---------------------------------------------------------------- événements Google Agenda
const evIndex = new Map();
const evKey = e => `${e.cal}|${e.id}`;
const evAttrs = e => e.id ? `data-ev="${esc(evKey(e))}" ${e.canEdit ? 'draggable="true"' : ""}` : "";
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = d => ({ dateTime: d.toISOString(), timeZone: TZ });
const hhmm = d => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 864e5);

function bindEventBlocks() {
  $$(".cal [data-ev]").forEach(el => {
    const ev = evIndex.get(el.dataset.ev);
    if (!ev) return;
    el.addEventListener("click", e => { if (!e.target.classList.contains("resize")) openEvent(ev); });
    if (!ev.canEdit) return;
    el.addEventListener("dragstart", e => {
      if (resizing) return e.preventDefault();
      e.dataTransfer.setData("text/plain", ev.title); drag.ev = ev; drag.id = null;
      drag.offset = ev.allday ? 0 : e.clientY - el.getBoundingClientRect().top;
      setTimeout(() => el.style.opacity = .3);
    });
    el.addEventListener("dragend", () => { el.style.opacity = ""; drag.ev = null; drag.offset = 0; clearDropMarks(); });
    el.querySelector(".resize")?.addEventListener("pointerdown", e => resizeEvent(e, el, ev));
  });
}

// Vérifie l'accès en écriture ; propose de l'accorder si besoin.
async function ensureCalendarWrite() {
  try { await google.ensureToken({ interactive: true }); } catch (e) { toast(e.message, { error: true }); return false; }
  if (google.canWriteCalendar()) return true;
  const ok = await confirmModal("Autoriser la modification de l'agenda ?",
    "L'appli n'a pour l'instant qu'un accès en lecture à ton agenda. Google va te demander d'autoriser « Afficher et modifier les événements ».", "Autoriser");
  if (!ok) return false;
  try { await google.upgradeCalendar(); return true; } catch (e) { toast(e.message, { error: true }); return false; }
}

// Prévenir les invités ? (comme Google Agenda) — "all", "none", ou null si annulé.
function guestChoice(ev) {
  if (!ev.guests) return Promise.resolve("none");
  return new Promise(resolve => {
    const bg = modal(`<h2>Prévenir les invités ?</h2><div class="muted">« ${esc(ev.title)} » a ${ev.guests} invité(s). Leur envoyer un e-mail de mise à jour ?</div>
      <div class="row"><button id="g-cancel">Annuler</button><button id="g-none">Ne pas prévenir</button><button class="primary" id="g-all">Prévenir</button></div>`);
    const done = v => { bg.remove(); resolve(v); };
    $("#g-cancel", bg).onclick = () => done(null);
    $("#g-none", bg).onclick = () => done("none");
    $("#g-all", bg).onclick = () => done("all");
    new MutationObserver((_, o) => { if (!bg.isConnected) { o.disconnect(); resolve(null); } }).observe(document.body, { childList: true });
  });
}

const refreshEvents = () => { calendar.invalidate(); ui.eventsKey = null; renderDay(); };

async function saveEvent(ev, body, { undo = null, message = "Événement modifié" } = {}) {
  if (!(await ensureCalendarWrite())) { renderDay(); return false; }
  const notify = await guestChoice(ev);
  if (!notify) { renderDay(); return false; }
  try {
    await google.patchEvent(ev.cal, ev.id, body, notify);
  } catch (e) {
    toast(`Modification impossible : ${e.message}`, { error: true });
    renderDay();
    return false;
  }
  refreshEvents();
  toast(message, undo ? { undo: () => google.patchEvent(ev.cal, ev.id, undo, notify).then(refreshEvents) } : {});
  return true;
}
const original = ev => ev.allday ? { start: { date: ev.s }, end: { date: ev.e } } : { start: at(new Date(ev.s)), end: at(new Date(ev.e)) };

function moveEvent(ev, date, minute) {
  const start = parseISO(date); start.setMinutes(minute);
  if (start.getTime() === new Date(ev.s).getTime()) return;
  const end = new Date(start.getTime() + (new Date(ev.e) - new Date(ev.s)));
  saveEvent(ev, { start: at(start), end: at(end) }, { undo: original(ev), message: `« ${ev.title} » déplacé : ${dayLabel(date)} ${hhmm(start)}` });
}
function shiftAllDayEvent(ev, date) {
  const delta = daysBetween(ev.s, date);
  if (!delta) return;
  saveEvent(ev, { start: { date: addDays(ev.s, delta) }, end: { date: addDays(ev.e, delta) } },
    { undo: original(ev), message: `« ${ev.title} » déplacé : ${dayLabel(date)}` });
}
function resizeEvent(e, block, ev) {
  e.preventDefault(); e.stopPropagation(); resizing = true; block.draggable = false;
  const startY = e.clientY, startH = block.offsetHeight, pxMin = hourPx() / 60;
  const dur0 = Math.round((new Date(ev.e) - new Date(ev.s)) / 60e3);
  let dur = dur0;
  const move = m => { dur = Math.min(1440, Math.max(SNAP, Math.round((startH + m.clientY - startY) / pxMin / SNAP) * SNAP)); block.style.height = dur * pxMin - 2 + "px"; };
  const up = () => {
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); resizing = false;
    if (dur === dur0) { block.draggable = true; return; }
    const end = new Date(new Date(ev.s).getTime() + dur * 60e3);
    saveEvent(ev, { end: at(end) }, { undo: { end: at(new Date(ev.e)) }, message: `« ${ev.title} » : fin à ${hhmm(end)}` });
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}

const plainText = html => {
  const d = document.createElement("div");
  d.innerHTML = String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
  return d.textContent.trim();
};

function openEvent(ev) {
  const s = ev.allday ? null : new Date(ev.s), e = ev.allday ? null : new Date(ev.e);
  const when = ev.allday
    ? (daysBetween(ev.s, ev.e) > 1 ? `Du ${dayLabel(ev.s, true)} au ${dayLabel(addDays(ev.e, -1), true)}` : cap(dayLabel(ev.s, true)))
    : `${cap(dayLabel(iso(s), true))}, ${hhmm(s)} – ${hhmm(e)}`;
  const link = ev.link && /^https:\/\/(www\.)?google\.com\//.test(ev.link)
    ? `<a href="${esc(ev.link)}" target="_blank" rel="noopener noreferrer">Ouvrir dans Google Agenda</a>` : "";
  if (!ev.canEdit) {
    const bg = modal(`<h2>${esc(ev.title)}</h2><div class="muted">${esc(when)}</div>
      ${ev.location ? `<div>📍 ${esc(ev.location)}</div>` : ""}
      ${ev.description ? `<div class="note"><div class="nb">${noteHTML(plainText(ev.description))}</div></div>` : ""}
      <div class="small muted">Cet événement n'est pas modifiable ici (agenda en lecture seule, ou tu es invité).</div>
      <div class="row">${link ? `<span style="margin-right:auto">${link}</span>` : ""}<button id="e-close">Fermer</button></div>`);
    $("#e-close", bg).onclick = () => bg.remove();
    return;
  }
  const bg = modal(`<h2>Modifier l'événement</h2>
    <label for="e-title">Titre</label><input id="e-title" maxlength="1000">
    <label class="toggle"><input type="checkbox" id="e-allday"> Journée entière</label>
    <div class="inline" id="e-timed" style="align-items:center;flex-wrap:wrap">
      <input type="date" id="e-date"> <input type="time" id="e-start" step="300"> à <input type="time" id="e-end" step="300"></div>
    <div class="inline hidden" id="e-days" style="align-items:center;flex-wrap:wrap"><input type="date" id="e-d0"> au <input type="date" id="e-d1"></div>
    <label for="e-loc">Lieu</label><input id="e-loc" maxlength="1000">
    <label for="e-desc">Description</label><textarea id="e-desc" rows="4"></textarea>
    ${ev.recurring ? `<div class="small muted">Événement récurrent : seule cette occurrence est modifiée.</div>` : ""}
    ${ev.guests ? `<div class="small muted">${ev.guests} invité(s) : tu choisiras de les prévenir ou non.</div>` : ""}
    <div class="row"><button class="danger" id="e-del" style="margin-right:auto">Supprimer</button>${link}
      <button id="e-cancel">Annuler</button><button class="primary" id="e-save">Enregistrer</button></div>`);
  const $m = sel => $(sel, bg);
  $m("#e-title").value = ev.title === "(sans titre)" ? "" : ev.title;
  $m("#e-loc").value = ev.location;
  $m("#e-desc").value = plainText(ev.description);
  $m("#e-allday").checked = ev.allday;
  if (ev.allday) {
    $m("#e-d0").value = ev.s; $m("#e-d1").value = addDays(ev.e, -1);
    $m("#e-date").value = ev.s; $m("#e-start").value = "09:00"; $m("#e-end").value = "10:00";
  } else {
    $m("#e-date").value = iso(s); $m("#e-start").value = hhmm(s); $m("#e-end").value = hhmm(e);
    $m("#e-d0").value = $m("#e-d1").value = iso(s);
  }
  const syncMode = () => {
    $m("#e-timed").classList.toggle("hidden", $m("#e-allday").checked);
    $m("#e-days").classList.toggle("hidden", !$m("#e-allday").checked);
  };
  $m("#e-allday").onchange = syncMode; syncMode();
  $m("#e-title").focus();
  $m("#e-cancel").onclick = () => bg.remove();
  $m("#e-save").onclick = async () => {
    const body = { summary: $m("#e-title").value.trim() || "(sans titre)", location: $m("#e-loc").value.trim(), description: $m("#e-desc").value };
    if (body.description === plainText(ev.description)) delete body.description; // ne pas écraser une mise en forme existante
    if ($m("#e-allday").checked) {
      const d0 = $m("#e-d0").value, d1 = $m("#e-d1").value || d0;
      if (!d0 || d1 < d0) return toast("Dates invalides : la fin doit suivre le début.", { error: true });
      Object.assign(body, { start: { date: d0 }, end: { date: addDays(d1, 1) } });
    } else {
      const d = $m("#e-date").value, a = $m("#e-start").value, b = $m("#e-end").value;
      if (!d || !a || !b) return toast("Indique la date et les heures.", { error: true });
      const st = parseISO(d); st.setHours(+a.slice(0, 2), +a.slice(3, 5));
      const en = parseISO(d); en.setHours(+b.slice(0, 2), +b.slice(3, 5));
      if (en <= st) en.setDate(en.getDate() + 1); // se termine le lendemain
      Object.assign(body, { start: at(st), end: at(en) });
    }
    bg.remove();
    await saveEvent(ev, body);
  };
  $m("#e-del").onclick = async () => {
    bg.remove();
    if (!(await confirmModal(`Supprimer « ${ev.title} » ?`,
      ev.recurring ? "Seule cette occurrence sera supprimée de ton Google Agenda." : "L'événement sera supprimé de ton Google Agenda.", "Supprimer"))) return;
    if (!(await ensureCalendarWrite())) return;
    const notify = await guestChoice(ev);
    if (!notify) return;
    try { await google.deleteEvent(ev.cal, ev.id, notify); }
    catch (err) { return toast(`Suppression impossible : ${err.message}`, { error: true }); }
    refreshEvents();
    toast("Événement supprimé");
  };
}

// ---------------------------------------------------------------- notes
function noteHTML(text) {
  let h = esc(text);
  h = h.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/(https?:\/\/[^\s<&]+(?:&amp;[^\s<&]+)*)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  h = h.replace(/^- (.*)$/gm, "• $1");
  return h.replace(/\n/g, "<br>");
}
function noteCard(n, { withTask }) {
  const p = n.project_id ? project(n.project_id) : null;
  const where = !withTask ? "" : n.task_id
    ? `· ${p ? `<i class="dot" style="background:${p.color}"></i>` : ""}<a data-task="${n.task_id}">${esc(n.task_title)}</a>` : "· note libre";
  return `<div class="note" data-note="${n.id}"><div class="nh">${withTask ? timeLabel(n.created_at) : cap(stampLabel(n.created_at))} ${where}
    ${n.updated_at ? `<span class="faint">(modifiée)</span>` : ""}
    <span class="tools"><button class="ghost n-edit">Modifier</button><button class="ghost n-del">Supprimer</button></span></div>
    <div class="nb">${noteHTML(n.body)}</div></div>`;
}
function bindNoteCards(root, notes, reload) {
  $$(".note[data-note]", root).forEach(el => {
    const n = notes.find(x => x.id === el.dataset.note);
    el.querySelector("a[data-task]")?.addEventListener("click", () => openTask(n.task_id));
    el.querySelector(".n-del").onclick = async () => {
      await api("DELETE", `notes/${n.id}`); await reload();
      toast("Note supprimée", { undo: () => api("POST", `notes/${n.id}/restore`, {}) });
    };
    el.querySelector(".n-edit").onclick = () => {
      const nb = el.querySelector(".nb");
      nb.innerHTML = `<textarea rows="${Math.min(12, n.body.split("\n").length + 1)}"></textarea>
        <div style="display:flex;gap:6px;margin-top:4px"><button class="primary n-save">Enregistrer</button><button class="n-cancel">Annuler</button></div>`;
      const ta = nb.querySelector("textarea"); ta.value = n.body; ta.focus();
      const save = async () => { const b = ta.value.trim(); if (!b) return toast("Une note ne peut pas être vide.", { error: true }); await api("PATCH", `notes/${n.id}`, { body: b }); await reload(); };
      nb.querySelector(".n-save").onclick = save;
      nb.querySelector(".n-cancel").onclick = () => { nb.innerHTML = noteHTML(n.body); };
      ta.addEventListener("keydown", e => { if (e.key === "Enter" && e.ctrlKey) save(); if (e.key === "Escape") { e.stopPropagation(); nb.innerHTML = noteHTML(n.body); } });
    };
  });
}
function bindDraft(ta, key) {
  ta.value = localGet(key, "");
  ta.addEventListener("input", () => localSet(key, ta.value));
}

let notesCache = [], notesQuery = "";
async function renderNotes() {
  const v = $("#view-notes");
  if (!v.dataset.ready) {
    v.innerHTML = `<div class="narrow">
      <textarea id="free-note" rows="3" style="width:100%" placeholder="Note libre… (Ctrl+Entrée pour enregistrer)"></textarea>
      <div style="display:flex;gap:8px;margin:8px 0 4px"><button class="primary" id="save-free">Enregistrer</button><input id="note-search" placeholder="Rechercher dans les notes" style="flex:1"></div>
      <div id="notes-list"></div></div>`;
    v.dataset.ready = 1;
    const ta = $("#free-note");
    bindDraft(ta, "draft:free");
    const save = async () => {
      const b = ta.value.trim(); if (!b) return;
      await api("POST", "notes", { body: b, task_id: null });
      ta.value = ""; localSet("draft:free", ""); renderNotes();
    };
    $("#save-free").onclick = save;
    ta.addEventListener("keydown", e => { if (e.key === "Enter" && e.ctrlKey) save(); });
    $("#note-search").addEventListener("input", e => { notesQuery = norm(e.target.value); drawNotes(); });
  }
  notesCache = await api("GET", "notes");
  drawNotes();
}
function drawNotes() {
  let list = notesCache.filter(n => ui.project == null || n.project_id === ui.project);
  if (notesQuery) list = list.filter(n => norm(n.body + " " + (n.task_title || "")).includes(notesQuery));
  let last = "", html = "";
  for (const n of list) {
    const d = n.created_at.slice(0, 10);
    if (d !== last) { html += `<div class="day-sep">${cap(dayLabel(d, true))}</div>`; last = d; }
    html += noteCard(n, { withTask: true });
  }
  $("#notes-list").innerHTML = html || `<div class="empty">${notesQuery ? "Aucune note ne correspond." : "Aucune note pour l'instant."}</div>`;
  bindNoteCards($("#notes-list"), list, renderNotes);
}

// ---------------------------------------------------------------- corbeille
async function renderTrash() {
  const items = await api("GET", "trash");
  const v = $("#view-trash");
  v.innerHTML = `<div class="narrow"><p class="muted small">Les tâches supprimées restent ici 30 jours, avec leurs notes et sous-tâches, puis sont effacées.</p>
    ${items.map(t => `<div class="trash-row" data-id="${t.id}"><div class="body"><div>${esc(t.title)}</div>
      <div class="meta">${project(t.project_id) ? `<span><i class="dot" style="background:${project(t.project_id).color}"></i>${esc(project(t.project_id).name)}</span>` : ""}
      <span>supprimée ${stampLabel(t.deleted_at)}</span>${t.note_count ? `<span>✎ ${t.note_count}</span>` : ""}</div></div>
      <button class="t-restore">Restaurer</button><button class="ghost danger t-purge">Supprimer définitivement</button></div>`).join("")
      || `<div class="empty">La corbeille est vide.</div>`}</div>`;
  $$(".trash-row", v).forEach(row => {
    const id = row.dataset.id, t = items.find(x => x.id === id);
    row.querySelector(".t-restore").onclick = async () => { await api("POST", `tasks/${id}/restore`, {}); await load(); toast(`« ${t.title} » restaurée`); };
    row.querySelector(".t-purge").onclick = async () => {
      if (!(await confirmModal(`Supprimer définitivement « ${t.title} » ?`, "Ses notes et sous-tâches seront effacées. Cette action est irréversible.", "Supprimer définitivement"))) return;
      await api("DELETE", `tasks/${id}/purge`); await load();
    };
  });
}

// ---------------------------------------------------------------- panneau tâche
async function openTask(id) {
  ui.openTask = id;
  $("#drawer").classList.remove("hidden");
  $$(".task.selected").forEach(e => e.classList.remove("selected"));
  $$(`.task[data-id="${id}"]`).forEach(e => e.classList.add("selected"));
  await renderDrawer();
}
function closeDrawer() {
  ui.openTask = null;
  $("#drawer").classList.add("hidden");
  $$(".task.selected").forEach(e => e.classList.remove("selected"));
}
let drawerSeq = 0;
async function renderDrawer() {
  const t = findTask(ui.openTask);
  if (!t) return closeDrawer();
  const seq = ++drawerSeq;
  const [notes, events] = await Promise.all([api("GET", `notes?task_id=${t.id}`), api("GET", `tasks/${t.id}/events`)]);
  if (seq !== drawerSeq || ui.openTask !== t.id) return; // un rendu plus récent a pris le relais
  const d = $("#drawer");
  const focused = document.activeElement?.id;
  const historyOpen = d.dataset.task == t.id && $("#dr-history")?.open;
  d.dataset.task = t.id;
  d.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span class="small" style="color:${QUADS[t.quadrant].color}">● ${QUADS[t.quadrant].name}</span>
      <button class="ghost" id="dr-close" title="Fermer (Échap)" aria-label="Fermer">✕</button></div>
    <input class="ttl" id="dr-title" maxlength="500" aria-label="Titre">
    <div class="actions">
      <button class="primary" id="dr-done">${t.done ? "Rouvrir" : "✓ Terminer"}</button>
      ${t.done ? "" : `<button id="dr-today">${t.planned_date === S.today ? "Retirer d'aujourd'hui" : "Faire aujourd'hui"}</button><button id="dr-tomorrow">Reporter à demain</button>`}
    </div>
    <div class="props">
      <label for="dr-project">Projet</label><select id="dr-project"><option value="">Aucun</option>${S.projects.map(p => `<option value="${p.id}" ${p.id === t.project_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
      <label for="dr-quad">Quadrant</label><select id="dr-quad">${[1, 2, 3, 4].map(q => `<option value="${q}" ${q === t.quadrant ? "selected" : ""}>${q}. ${QUADS[q].name}</option>`).join("")}</select>
      <label for="dr-due">Échéance</label><input type="date" id="dr-due" value="${t.due || ""}">
      <label for="dr-est">Durée estimée</label><select id="dr-est">${[15, 30, 45, 60, 90, 120, 180, 240, 360, 480].concat(t.estimate).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map(m => `<option value="${m}" ${m === t.estimate ? "selected" : ""}>${fmtMin(m)}</option>`).join("")}</select>
      <label for="dr-pdate">Planifiée</label><div class="inline"><input type="date" id="dr-pdate" value="${t.planned_date || ""}" style="flex:1"><input type="time" id="dr-pstart" step="900" value="${t.planned_start || ""}" aria-label="Heure planifiée"></div>
      ${t.reports ? `<label>Reports</label><span><span class="badge warn">${t.reports}×</span>${t.carried_from ? ` <span class="small muted">dernier : ${dayLabel(t.carried_from)}</span>` : ""}</span>` : ""}
    </div>
    <div><h3>Sous-tâches ${t.subtasks.length ? `· ${t.subtasks.filter(s => s.done).length}/${t.subtasks.length}` : ""}</h3>
      ${t.subtasks.map(s => `<div class="sub ${s.done ? "done" : ""}" data-sid="${s.id}"><input type="checkbox" class="check" ${s.done ? "checked" : ""} aria-label="Fait"><span>${esc(s.title)}</span><button class="ghost del" title="Supprimer" aria-label="Supprimer la sous-tâche">✕</button></div>`).join("")}
      <input id="dr-sub" placeholder="+ Ajouter une sous-tâche" style="width:100%;margin-top:4px" maxlength="300"></div>
    <div><h3>Journal de notes</h3>
      <textarea id="dr-note" rows="3" style="width:100%" placeholder="Ajouter une note… (Ctrl+Entrée)"></textarea>
      <div style="margin:4px 0 8px"><button id="dr-addnote">Ajouter la note</button></div>
      <div id="dr-notes">${notes.map(n => noteCard(n, { withTask: false })).join("") || `<div class="empty">Pas encore de note.</div>`}</div>
    </div>
    <details class="history" id="dr-history" ${historyOpen ? "open" : ""}><summary>Historique</summary>
      ${events.map(e => `<div>${cap(stampLabel(e.at))} · ${historyLine(e)}</div>`).join("")}</details>
    <div style="margin-top:auto;padding-top:12px"><button class="danger" id="dr-delete">Mettre à la corbeille</button></div>`;

  const id = t.id;
  const title = $("#dr-title"); title.value = t.title;
  $("#dr-close").onclick = closeDrawer;
  $("#dr-done").onclick = () => setDone(id, !t.done);
  $("#dr-today")?.addEventListener("click", () => patchTask(id, t.planned_date === S.today ? { planned_date: null } : { planned_date: S.today }));
  $("#dr-tomorrow")?.addEventListener("click", () => patchTask(id, { planned_date: addDays(S.today, 1), planned_start: null }));
  title.addEventListener("keydown", e => { if (e.key === "Enter") title.blur(); if (e.key === "Escape") { title.value = t.title; title.blur(); } });
  title.addEventListener("change", () => title.value.trim() ? patchTask(id, { title: title.value.trim() }) : (title.value = t.title));
  $("#dr-project").onchange = e => patchTask(id, { project_id: e.target.value || null });
  $("#dr-quad").onchange = e => patchTask(id, { quadrant: +e.target.value });
  $("#dr-due").onchange = e => patchTask(id, { due: e.target.value || null });
  $("#dr-est").onchange = e => patchTask(id, { estimate: +e.target.value });
  $("#dr-pdate").onchange = e => patchTask(id, { planned_date: e.target.value || null });
  $("#dr-pstart").onchange = e => patchTask(id, { planned_start: e.target.value || null, planned_date: t.planned_date || S.today });
  $$(".sub", d).forEach(s => {
    const sid = s.dataset.sid;
    s.querySelector(".check").onchange = async e => { await api("PATCH", `subtasks/${sid}`, { done: e.target.checked ? 1 : 0 }); load(); };
    s.querySelector(".del").onclick = async () => { await api("DELETE", `subtasks/${sid}`); load(); };
  });
  const sub = $("#dr-sub");
  sub.addEventListener("keydown", async e => {
    if (e.key !== "Enter" || !sub.value.trim()) return;
    await api("POST", "subtasks", { task_id: id, title: sub.value.trim() }); sub.value = ""; await load();
  });
  const noteTa = $("#dr-note");
  bindDraft(noteTa, `draft:task:${id}`);
  const addNote = async () => {
    const b = noteTa.value.trim(); if (!b) return;
    await api("POST", "notes", { task_id: id, body: b });
    noteTa.value = ""; localSet(`draft:task:${id}`, ""); await load();
  };
  $("#dr-addnote").onclick = addNote;
  noteTa.addEventListener("keydown", e => { if (e.key === "Enter" && e.ctrlKey) addNote(); });
  bindNoteCards($("#dr-notes"), notes, load);
  $("#dr-delete").onclick = () => deleteTask(id);
  if (focused && ["dr-sub", "dr-note"].includes(focused)) $("#" + focused).focus();
}
function historyLine(e) {
  const label = EVENT_LABELS[e.kind] || e.kind;
  if (e.kind === "reported") return `${label} ${dayLabel(e.detail)})`;
  if (e.kind === "renamed") return `${label} « ${esc(e.detail)} »)`;
  if (e.kind === "quadrant") { const [a, b] = e.detail.split("→"); return `${label} : ${QUADS[a]?.name} → ${QUADS[b]?.name}`; }
  if (e.kind === "planned") { const [d, h] = e.detail.split(" "); return `${label} ${dayLabel(d)}${h ? " à " + h : ""}`; }
  return label;
}

// ---------------------------------------------------------------- fenêtres
function modal(html) {
  const bg = document.createElement("div"); bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(bg);
  bg.addEventListener("mousedown", e => { if (e.target === bg) bg.remove(); });
  return bg;
}
function confirmModal(title, text, okLabel = "Confirmer") {
  return new Promise(resolve => {
    const bg = modal(`<h2>${esc(title)}</h2><div class="muted">${esc(text)}</div>
      <div class="row"><button id="m-no">Annuler</button><button class="primary" id="m-yes">${esc(okLabel)}</button></div>`);
    const done = v => { bg.remove(); resolve(v); };
    $("#m-no", bg).onclick = () => done(false);
    $("#m-yes", bg).onclick = () => done(true);
    new MutationObserver((_, o) => { if (!bg.isConnected) { o.disconnect(); resolve(false); } }).observe(document.body, { childList: true });
    $("#m-yes", bg).focus();
  });
}
function projectModal(p) {
  const isNew = !p;
  let color = p?.color || PALETTE[S.projects.length % PALETTE.length];
  const bg = modal(`<h2>${isNew ? "Nouveau projet" : "Modifier le projet"}</h2>
    <label for="p-name">Nom</label><input id="p-name" maxlength="80">
    <label>Couleur</label><div class="swatches">${PALETTE.map(c => `<button class="swatch" data-c="${c}" style="background:${c}" aria-label="Couleur ${c}"></button>`).join("")}</div>
    <div class="row">${isNew ? "" : `<button class="danger" id="p-del" style="margin-right:auto">Supprimer le projet</button>`}
      <button id="p-cancel">Annuler</button><button class="primary" id="p-save">${isNew ? "Créer" : "Enregistrer"}</button></div>`);
  const name = $("#p-name", bg); name.value = p?.name || ""; name.focus();
  const paint = () => $$(".swatch", bg).forEach(s => s.classList.toggle("on", s.dataset.c === color));
  $$(".swatch", bg).forEach(s => s.onclick = () => { color = s.dataset.c; paint(); });
  paint();
  const save = async () => {
    if (!name.value.trim()) return toast("Le nom du projet est vide.", { error: true });
    if (isNew) await api("POST", "projects", { name: name.value.trim(), color });
    else await api("PATCH", `projects/${p.id}`, { name: name.value.trim(), color });
    bg.remove(); await load();
  };
  $("#p-save", bg).onclick = save;
  name.addEventListener("keydown", e => { if (e.key === "Enter") save(); });
  $("#p-cancel", bg).onclick = () => bg.remove();
  $("#p-del", bg)?.addEventListener("click", async () => {
    const n = S.tasks.filter(t => t.project_id === p.id).length;
    bg.remove();
    if (!(await confirmModal(`Supprimer le projet « ${p.name} » ?`, `${n ? `Ses ${n} tâche(s) sont conservées, sans projet.` : "Il ne contient aucune tâche."}`, "Supprimer"))) return;
    await api("DELETE", `projects/${p.id}`); await load();
  });
}

const whenLabel = s => { const d = new Date(s); return isNaN(d) ? "" : `${dayLabel(iso(d))} ${timeLabel(s)}`; };
const backupLabel = n => n.startsWith("backup-") ? `Sauvegarde du ${dayLabel(n.slice(7, 17), true)}`
  : n.startsWith("avant-restauration-") ? "État avant une restauration"
    : n.startsWith("corrompu-") ? "Fichier illisible mis de côté" : n;

async function openSettings() {
  const bg = modal(`<h2>Paramètres</h2>
    <h3 class="mh">Synchronisation Google</h3>
    <div id="g-box" class="gbox"></div>
    <h3 class="mh">Planning</h3>
    <label>Plage horaire</label>
    <div class="inline" style="align-items:center"><input type="number" id="h0" min="0" max="23" style="width:70px"> h à <input type="number" id="h1" min="1" max="24" style="width:70px"> h</div>
    <div id="cal-box"></div>
    <h3 class="mh">Données</h3>
    <div class="small muted" id="storage-info">Tes données sont enregistrées dans ce navigateur${google.enabled() ? " et synchronisées dans un dossier caché de ton Google Drive" : ""}.</div>
    <div class="inline wrap"><button id="export">Exporter (JSON)</button><label class="btn" for="import-file" tabindex="0" id="import-label">Importer un fichier…</label><input type="file" id="import-file" accept=".json,application/json" hidden></div>
    <div class="small muted">L'import fusionne le fichier avec tes données : export de cette appli, ou export JSON de pyPriority pour PC.</div>
    <div id="backups-box"></div>
    <div class="small faint">Version ${APP_VERSION} · appareil ${esc(store.device)}</div>
    <div class="row"><button id="cancel">Fermer</button><button class="primary" id="save">Enregistrer</button></div>`);
  $("#h0", bg).value = S.settings.day_start || 7;
  $("#h1", bg).value = S.settings.day_end || 21;
  let calendars = null;

  const drawGoogle = () => {
    const box = $("#g-box", bg);
    if (!google.configured()) {
      box.innerHTML = `<div class="small muted">La connexion Google n'est pas encore configurée : il faut un identifiant client dans <code>config.js</code> (voir INSTALLATION.md). En attendant, tes données restent sur cet appareil.</div>
        <div class="inline"><input id="cid" placeholder="Identifiant client (…apps.googleusercontent.com)" style="flex:1"><button id="cid-save">Utiliser</button></div>`;
      $("#cid-save", box).onclick = () => {
        const v = $("#cid", box).value.trim();
        if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(v)) return toast("Identifiant client invalide.", { error: true });
        localSet("g:client_id", v); location.reload();
      };
      return;
    }
    if (!google.enabled()) {
      box.innerHTML = `<div class="small muted">Tes données restent sur cet appareil. Connecte ton compte Google pour les retrouver sur ton téléphone et ton PC, et afficher ton agenda dans le planning.</div>
        <div><button class="primary" id="g-connect">Connecter Google</button></div>`;
      $("#g-connect", box).onclick = async () => {
        try { await google.connect(); } catch (e) { return toast(e.message, { error: true }); }
        calendar.invalidate(); ui.eventsKey = null;
        drawGoogle(); drawCalendars(); drawBackups();
        toast("Compte Google connecté. Synchronisation…");
        await sync.run({ interactive: true });
        drawGoogle();
        await load();
      };
      return;
    }
    const st = sync.status;
    box.innerHTML = `<div>Connecté : <b>${esc(google.email() || "compte Google")}</b></div>
      <div class="small muted">${esc(syncLabel(st).text)}${st.at ? ` · dernière synchronisation ${esc(whenLabel(st.at))}` : ""}${st.error && st.state !== "ok" ? `<br>${esc(st.error)}` : ""}</div>
      <div class="inline wrap"><button id="g-sync">Synchroniser maintenant</button><button class="ghost danger" id="g-off">Déconnecter</button></div>`;
    $("#g-sync", box).onclick = async () => { await sync.run({ interactive: true }); drawGoogle(); drawCalendars(); await load(); };
    $("#g-off", box).onclick = async () => {
      if (!(await confirmModal("Déconnecter Google ?", "Tes données restent sur cet appareil et dans ton Drive ; la synchronisation s'arrête sur cet appareil.", "Déconnecter"))) return;
      google.disconnect(); sync.run(); calendar.invalidate(); ui.eventsKey = null;
      drawGoogle(); drawCalendars(); drawBackups(); render();
    };
  };

  const drawCalendars = async () => {
    const box = $("#cal-box", bg);
    calendars = null;
    if (!google.enabled()) { box.innerHTML = ""; return; }
    box.innerHTML = `<label>Agendas affichés dans le planning</label><div class="cal-list small muted">Chargement…</div>`;
    const list = $(".cal-list", box);
    if (!google.token()) {
      list.innerHTML = `<button id="cal-auth">Reconnecter Google pour choisir</button>`;
      $("#cal-auth", list).onclick = async () => {
        try { await google.ensureToken({ interactive: true }); drawCalendars(); } catch (e) { toast(e.message, { error: true }); }
      };
      return;
    }
    if (!google.hasCalendar()) { list.textContent = "Accès à l'agenda non autorisé. Déconnecte puis reconnecte Google en cochant l'agenda."; return; }
    try { calendars = await google.calendars(); } catch (e) { list.textContent = `Liste indisponible : ${e.message}`; return; }
    const sel = new Set(calendar.selected());
    list.classList.remove("muted");
    list.innerHTML = calendars.map(c => `<label><input type="checkbox" value="${esc(c.id)}" ${sel.has(c.id) ? "checked" : ""}>
      <i class="dot" style="background:${/^#[0-9a-f]{6}$/i.test(c.color || "") ? c.color : "#888780"}"></i>${esc(c.name)}${c.primary ? " (principal)" : ""}</label>`).join("") || "Aucun agenda.";
  };

  const drawBackups = () => {
    const box = $("#backups-box", bg);
    if (!google.enabled()) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="small muted">Une sauvegarde est faite chaque jour dans ton Drive (30 conservées).</div>
      <div><button id="bk-show">Voir les sauvegardes Drive</button></div><div id="bk-list"></div>`;
    $("#bk-show", box).onclick = async () => {
      const out = $("#bk-list", box);
      out.textContent = "Chargement…";
      let files;
      try { files = await sync.listBackups(); } catch (e) { out.textContent = e.message; return; }
      out.innerHTML = files.map(f => `<div class="backup-row"><span>${esc(backupLabel(f.name))}<span class="faint"> · ${esc(whenLabel(f.modifiedTime))}</span></span>
        <button data-id="${esc(f.id)}">Restaurer</button></div>`).join("") || `<div class="empty">Aucune sauvegarde pour l'instant.</div>`;
      $$("button[data-id]", out).forEach(b => b.onclick = async () => {
        if (!(await confirmModal("Restaurer cette sauvegarde ?", "Toutes tes données, sur tous tes appareils, reviendront à cet état. L'état actuel est d'abord sauvegardé dans Drive.", "Restaurer"))) return;
        try { await sync.restore(b.dataset.id); toast("Sauvegarde restaurée"); bg.remove(); await load(); }
        catch (e) { toast(e.message, { error: true }); }
      });
    };
  };

  drawGoogle(); drawCalendars(); drawBackups();
  navigator.storage?.persisted?.().then(p => {
    if (!p) $("#storage-info", bg)?.insertAdjacentText("beforeend", ` Le navigateur peut effacer ces données s'il manque de place : ${google.enabled() ? "Drive en garde une copie." : "connecte Google ou exporte régulièrement."}`);
  }).catch(() => {});

  $("#cancel", bg).onclick = () => bg.remove();
  $("#save", bg).onclick = async () => {
    const data = { day_start: String(+$("#h0", bg).value || 0), day_end: String(+$("#h1", bg).value || 24) };
    if (calendars) data.calendars = JSON.stringify($$(".cal-list input:checked", bg).map(i => i.value));
    await api("PUT", "settings", data);
    calendar.invalidate(); ui.eventsKey = null;
    bg.remove(); await load(); toast("Paramètres enregistrés");
  };
  $("#export", bg).onclick = async () => {
    const data = await api("GET", "export");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = `priorites-${S.today}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $("#import-label", bg).addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#import-file", bg).click(); } });
  $("#import-file", bg).onchange = async e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    let data;
    try { data = JSON.parse(await f.text()); } catch { return toast("Fichier JSON illisible.", { error: true }); }
    const r = await api("POST", "import", data);
    toast(r.mode === "v2" ? `Import terminé : ${r.tasks} tâche(s), ${r.notes} note(s), ${r.projects} projet(s).`
      : `Fusion terminée : ${r.changes} élément(s) mis à jour.`);
    await load();
  };
}

// ---------------------------------------------------------------- indicateur de synchronisation
function syncLabel(st) {
  switch (st.state) {
    case "local": return { text: "Données sur cet appareil", cls: "", icon: "☁" };
    case "syncing": return { text: "Synchronisation…", cls: "", icon: "⟳" };
    case "auth": return { text: "Toucher pour reconnecter Google", cls: "warn", icon: "⚠" };
    case "offline": return { text: st.pending ? "Hors ligne · modifications en attente" : "Hors ligne", cls: "warn", icon: "○" };
    case "error": return { text: "Erreur de synchronisation", cls: "err", icon: "⚠" };
    default:
      if (st.pending) return { text: "Modifications en attente", cls: "", icon: "●" };
      return st.at ? { text: `Synchronisé ${whenLabel(st.at)}`, cls: "ok", icon: "✓" } : { text: "Pas encore synchronisé", cls: "", icon: "☁" };
  }
}
function renderSyncChip(st) {
  const el = $("#sync-chip");
  if (!el) return;
  const l = syncLabel(st);
  el.className = `nav sync-chip ${l.cls}`;
  el.innerHTML = `<span aria-hidden="true">${l.icon}</span><span>${esc(l.text)}</span>`;
  el.title = st.error && st.state !== "ok" ? st.error : "";
  $("#m-menu")?.classList.toggle("alert", ["auth", "error"].includes(st.state));
}

// ---------------------------------------------------------------- mise à jour de l'appli (service worker)
function registerSW() {
  if (!("serviceWorker" in navigator) || new URLSearchParams(location.search).has("nosw")) return;
  navigator.serviceWorker.register("./sw.js").then(reg => {
    const offer = w => {
      if (!w || !navigator.serviceWorker.controller) return;
      $("#update").classList.remove("hidden");
      $("#update-btn").onclick = () => w.postMessage("skipWaiting");
    };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w?.addEventListener("statechange", () => { if (w.state === "installed") offer(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60_000);
  }).catch(e => console.warn("Service worker :", e));
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloading) { reloading = true; location.reload(); } });
}


// ---------------------------------------------------------------- démarrage
function setView(v) { ui.view = v; localSet("view", v); document.body.classList.remove("menu-open"); render(); }
$$(".nav[data-view]").forEach(n => {
  n.addEventListener("click", () => setView(n.dataset.view));
  n.addEventListener("keydown", e => { if (e.key === "Enter") setView(n.dataset.view); });
});
$$(".mobile-nav [data-view]").forEach(b => b.onclick = () => setView(b.dataset.view));
$("#m-menu").onclick = () => document.body.classList.toggle("menu-open");
$("#scrim").onclick = () => document.body.classList.remove("menu-open");
$("aside").addEventListener("click", e => {
  if (e.target.closest(".nav") && !e.target.closest(".proj-menu")) document.body.classList.remove("menu-open");
});
$("#open-settings").onclick = openSettings;
$("#sync-chip").onclick = () => {
  if (!google.enabled()) return openSettings();
  sync.run({ interactive: true }).then(ok => { if (ok) load().catch(() => {}); });
};
$("#add-project").onclick = () => projectModal(null);
$("#show-done").onchange = e => { ui.showDone = e.target.checked; render(); };
$("#search").addEventListener("input", e => { ui.search = e.target.value; render(); });
bindAddInput($("#quick"), () => ui.view === "day" && visibleDays().length === 1 ? { planned_date: ui.focus } : {});

async function boot() {
  try {
    store = await new Store(await IDBAdapter.open()).open();
  } catch (e) {
    console.error(e);
    $(".app").innerHTML = `<div class="fatal"><h2>Stockage local indisponible</h2><p>${esc(e?.message || e)}</p>
      <p class="muted">Le navigateur bloque peut-être le stockage (navigation privée, ou autre onglet de l'appli en cours de mise à jour). Ferme les autres onglets et recharge la page.</p></div>`;
    return;
  }
  google = new Google();
  calendar = new CalendarService(store, google);
  store.routes["GET calendar"] = (id, q) => calendar.range(q.get("date"), Math.min(31, Math.max(1, +q.get("days") || 1)));
  sync = new Sync(store, google, { onStatus: renderSyncChip });
  await sync.init();

  // Plusieurs onglets ouverts : chacun relit la base quand un autre l'a modifiée.
  const channel = "BroadcastChannel" in window ? new BroadcastChannel("pypriority") : null;
  let reloadPending = false;
  const refresh = () => {
    if (busy()) { reloadPending = true; return; }
    reloadPending = false;
    load().catch(() => {});
  };
  store.on(kind => {
    channel?.postMessage(kind);
    if (kind === "remote") { calendar.invalidate(); ui.eventsKey = null; refresh(); }
  });
  if (channel) channel.onmessage = async () => { await store.reload(); refresh(); };
  setInterval(() => { if (reloadPending) refresh(); }, 5000);

  const v = new URLSearchParams(location.search).get("view");
  if (["matrix", "day", "notes"].includes(v)) ui.view = v;
  google.preload();
  navigator.storage?.persist?.().catch(() => {});
  await load();

  sync.run();
  setInterval(() => { if (document.visibilityState === "visible") sync.run(); }, 5 * 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { sync.run(); refresh(); }
    else if (sync.dirty) sync.run();
  });
  window.addEventListener("online", () => sync.run());
  // Jeton Google expiré avec des modifications en attente : le premier clic relance la connexion.
  let retried = false;
  document.addEventListener("click", () => {
    if (!retried && sync.status.state === "auth" && sync.dirty) {
      retried = true;
      sync.run({ interactive: true }).then(ok => { if (ok) refresh(); });
    }
  }, true);
  registerSW();
}

document.addEventListener("keydown", e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === "Escape") {
    const m = $$(".modal-bg").at(-1);
    if (m) m.remove(); else if (typing) document.activeElement.blur(); else closeDrawer();
    return;
  }
  if (typing || e.ctrlKey || e.altKey || e.metaKey || $(".modal-bg")) return;
  if (e.key === "n" || e.key === "N") { e.preventDefault(); $("#quick").focus(); }
  if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
  if (e.key === "1") $(".nav[data-view=matrix]").click();
  if (e.key === "2") $(".nav[data-view=day]").click();
  if (e.key === "3") $(".nav[data-view=notes]").click();
  if (ui.view === "day") {
    const k = e.key.toLowerCase();
    if (k === "t") goTo(S.today);
    if (k === "d") setMode("1");
    if (k === "x") setMode("3");
    if (k === "w") setMode("7");
    if (e.key === "ArrowLeft") shiftDays(-1);
    if (e.key === "ArrowRight") shiftDays(1);
  }
});
if (!["1", "3", "7", "custom"].includes(ui.mode)) ui.mode = "1";
ui.customN = Math.min(MAX_DAYS, Math.max(2, ui.customN));

// Rechargement au retour sur l'onglet, passage à minuit, rafraîchissement du planning.
const busy = () => drag.id || drag.ev || resizing || miniSel || $(".modal-bg") || /TEXTAREA|INPUT/.test(document.activeElement?.tagName) && document.activeElement.closest(".note");
window.addEventListener("focus", () => { if (store && !busy()) load().catch(() => {}); });
setInterval(() => {
  if (!store || busy()) return;
  if (S.today && iso(new Date()) !== S.today) { if (ui.focus === S.today) ui.focus = iso(new Date()); load().catch(() => {}); }
  else if (ui.view === "day") renderDay();
}, 60000);

boot();
