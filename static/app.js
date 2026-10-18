"use strict";

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

// ---------------------------------------------------------------- serveur
class ApiError extends Error {}
let offline = false;

async function api(method, path, body) {
  let r;
  try {
    r = await fetch("/api/" + path, {
      method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    setOffline(true);
    const e = new ApiError("Serveur injoignable : modification non enregistrée.");
    toast(e.message, { error: true });
    throw e;
  }
  if (offline) setOffline(false);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new ApiError(data.error || `Erreur ${r.status}`);
    toast(e.message, { error: true });
    throw e;
  }
  return data;
}

function setOffline(on) {
  if (on === offline) return;
  offline = on;
  $("#offline").classList.toggle("hidden", !on);
  if (on) pingUntilBack();
}
async function pingUntilBack() {
  while (offline) {
    await new Promise(r => setTimeout(r, 3000));
    try { const r = await fetch("/api/ping"); if (r.ok) { setOffline(false); await load(); } } catch {}
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
const drag = { id: null, offset: 0 };
function bindTaskCards(root) {
  $$(".task", root).forEach(el => {
    const id = +el.dataset.id;
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
    const pid = n.dataset.pid ? +n.dataset.pid : null;
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
      const sortOf = el => findTask(+el.dataset.id).sort;
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

async function loadEvents(days) {
  const key = days[0] + "|" + days.length + "|" + (S.settings.ics_url || "");
  ui.eventsKey = key;
  if (!S.settings.ics_url) { ui.eventsByDate = {}; ui.calWarning = null; return; }
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
  if (it.kind === "event")
    return `<div class="block event" style="${pos}" title="${esc(it.e.title)} · ${it.e.start}"><div><div class="bt">${esc(it.e.title)}</div><div>${it.e.start} · ${fmtMin(it.e.minutes)}</div></div></div>`;
  const t = it.t, p = project(t.project_id);
  return `<div class="block task-b ${t.done ? "done" : ""}" draggable="true" data-id="${t.id}" style="${pos};background:${p ? p.color : QUADS[t.quadrant].hex}" title="${esc(t.title)} · ${t.planned_start}–${fromMin(it.end)}">
    <input type="checkbox" class="check" ${t.done ? "checked" : ""} aria-label="Terminer"><div><div class="bt">${esc(t.title)}</div><div>${t.planned_start}–${fromMin(it.end)}${t.note_count ? " · ✎ " + t.note_count : ""}</div></div><div class="resize" title="Tirer pour changer la durée"></div></div>`;
}

function renderDay() {
  const days = visibleDays();
  if (ui.eventsKey !== days[0] + "|" + days.length + "|" + (S.settings.ics_url || "")) {
    ui.eventsByDate = {};
    loadEvents(days).then(() => ui.view === "day" && renderDay()).catch(() => {});
  }
  const tasks = visibleTasks();
  const carried = tasks.filter(t => !t.done && t.carried_from && !t.planned_date);
  const todo = tasks.filter(t => !t.done && !t.planned_date && !t.carried_from).sort((a, b) => a.quadrant - b.quadrant || a.sort - b.sort);
  const perDay = days.map(d => {
    const evs = ui.eventsByDate[d] || [];
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
      <span class="stats">${fmtMin(totTask)} de tâches · ${fmtMin(totMeet)} de réunions${S.settings.ics_url ? "" : ` · <a href="#" id="link-settings">connecter Google Agenda</a>`}</span>
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
          ${perDay.map(p => `<div class="ad ${p.d < S.today ? "past" : ""}" data-date="${p.d}">${p.allday.map(e => `<div class="ev-chip" title="${esc(e.title)}">${esc(e.title)}</div>`).join("")}${p.noTime.map(chipHTML).join("")}</div>`).join("")}
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
    const id = +b.dataset.id;
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
  // pas de dépôt sur les jours passés : la tâche serait aussitôt « reportée »
  $$(".cal .col:not(.past)").forEach(col => {
    col.addEventListener("dragover", e => {
      if (!drag.id) return; e.preventDefault();
      const t = findTask(drag.id), m = minuteAt(col, e.clientY - drag.offset), pxMin = hourPx() / 60;
      let g = $(".ghost-block");
      if (g && g.parentNode !== col) { g.remove(); g = null; }
      if (!g) { g = document.createElement("div"); g.className = "ghost-block"; col.appendChild(g); }
      g.style.top = (m - dayRange[0] * 60) * pxMin + "px"; g.style.height = t.estimate * pxMin - 2 + "px";
      g.textContent = `${fromMin(m)}  ${t.title}`;
    });
    col.addEventListener("dragleave", e => { if (!col.contains(e.relatedTarget)) col.querySelector(".ghost-block")?.remove(); });
    col.addEventListener("drop", e => {
      e.preventDefault(); const id = drag.id; if (!id) return;
      const m = minuteAt(col, e.clientY - drag.offset); clearDropMarks();
      patchTask(id, { planned_date: col.dataset.date, planned_start: fromMin(m) });
    });
  });
  $$(".cal .ad:not(.past)").forEach(z => bindDropZone(z, () => ({ planned_date: z.dataset.date, planned_start: null })));
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
    const n = notes.find(x => x.id === +el.dataset.note);
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
    const id = +row.dataset.id, t = items.find(x => x.id === id);
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
  $("#dr-project").onchange = e => patchTask(id, { project_id: e.target.value ? +e.target.value : null });
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

async function openSettings() {
  const bg = modal(`<h2>Paramètres</h2>
    <label for="ics">Adresse iCal privée de ton Google Agenda</label>
    <input id="ics" placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics">
    <div class="small muted">Google Agenda → Paramètres → ton agenda → « Intégrer l'agenda » → « Adresse secrète au format iCal ». Lecture seule ; l'adresse reste dans ta base locale. Actualisation toutes les 5 minutes.</div>
    <label>Plage horaire du planning</label>
    <div class="inline" style="align-items:center"><input type="number" id="h0" min="0" max="23" style="width:70px"> h à <input type="number" id="h1" min="1" max="24" style="width:70px"> h</div>
    <h2 style="margin-top:10px">Données</h2>
    <div class="small muted">Tout est enregistré dans <code>priorites.db</code>, à côté de <code>app.py</code>. Une copie est faite chaque jour dans <code>backups/</code> (30 conservées). Pour restaurer : arrête l'application, remplace <code>priorites.db</code> par une copie renommée.</div>
    <div class="small" id="backup-info">…</div>
    <div class="inline"><button id="backup-now">Sauvegarder maintenant</button><button id="export">Exporter en JSON</button></div>
    <div class="row"><button class="danger" id="quit" style="margin-right:auto">Quitter l'application</button><button id="cancel">Annuler</button><button class="primary" id="save">Enregistrer</button></div>`);
  $("#ics", bg).value = S.settings.ics_url || "";
  $("#h0", bg).value = S.settings.day_start || 7;
  $("#h1", bg).value = S.settings.day_end || 21;
  const showBackup = last => { $("#backup-info", bg).textContent = last ? `Dernière sauvegarde : ${stampLabel(last.at)} (${last.name}), ${last.count} copie(s).` : "Aucune sauvegarde pour l'instant."; };
  api("GET", "backup").then(r => showBackup(r.last)).catch(() => {});
  $("#cancel", bg).onclick = () => bg.remove();
  $("#save", bg).onclick = async () => {
    await api("PUT", "settings", { ics_url: $("#ics", bg).value.trim() || null, day_start: String(+$("#h0", bg).value || 0), day_end: String(+$("#h1", bg).value || 24) });
    bg.remove(); ui.eventsKey = null; await load(); toast("Paramètres enregistrés");
  };
  $("#backup-now", bg).onclick = async () => { const r = await api("POST", "backup", {}); showBackup(r.last); toast("Sauvegarde effectuée"); };
  $("#export", bg).onclick = async () => {
    const data = await api("GET", "export");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = `priorites-${S.today}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $("#quit", bg).onclick = async () => {
    bg.remove();
    if (!(await confirmModal("Quitter pyPriority ?", "Le serveur s'arrête ; relance Lancer.bat pour l'utiliser à nouveau.", "Quitter"))) return;
    await api("POST", "shutdown", {});
    document.body.innerHTML = `<div style="margin:auto;text-align:center;color:var(--muted)"><p>pyPriority est arrêté.</p><p class="small">Tu peux fermer cet onglet.</p></div>`;
  };
  $("#ics", bg).focus();
}

// ---------------------------------------------------------------- démarrage
$$(".nav[data-view]").forEach(n => {
  const go = () => { ui.view = n.dataset.view; localSet("view", ui.view); render(); };
  n.addEventListener("click", go);
  n.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
});
$("#open-settings").onclick = openSettings;
$("#add-project").onclick = () => projectModal(null);
$("#show-done").onchange = e => { ui.showDone = e.target.checked; render(); };
$("#search").addEventListener("input", e => { ui.search = e.target.value; render(); });
bindAddInput($("#quick"), () => ui.view === "day" && visibleDays().length === 1 ? { planned_date: ui.focus } : {});

document.addEventListener("keydown", e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === "Escape") {
    const m = $(".modal-bg");
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
const busy = () => drag.id || resizing || miniSel || $(".modal-bg") || /TEXTAREA|INPUT/.test(document.activeElement?.tagName) && document.activeElement.closest(".note");
window.addEventListener("focus", () => { if (!busy()) load().catch(() => {}); });
setInterval(() => {
  if (offline || busy()) return;
  if (S.today && iso(new Date()) !== S.today) { if (ui.focus === S.today) ui.focus = iso(new Date()); load().catch(() => {}); }
  else if (ui.view === "day") renderDay();
}, 60000);

load().catch(() => {});
