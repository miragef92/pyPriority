// Données locales (IndexedDB), logique métier et fusion pour la synchronisation.
//
// Chaque enregistrement porte une horloge par champ (_clk) : lors d'une synchronisation, pour chaque
// champ, la valeur la plus récente gagne. Une suppression définitive laisse une « pierre tombale »
// (_deleted) pour qu'un autre appareil ne fasse pas réapparaître l'élément.

export const COLLECTIONS = ["projects", "tasks", "subtasks", "notes", "events", "settings"];
export const TRASH_DAYS = 30;
export const DONE_VISIBLE_DAYS = 14;
export const TOMBSTONE_DAYS = 180;
export const DEFAULT_PROJECT = { id: "p_default", name: "Perso", color: "#888780", sort: 0 };
const SETTING_KEYS = { day_start: 2, day_end: 2, calendars: 4000 };

export class ValidationError extends Error { constructor(m) { super(m); this.name = "ValidationError"; } }
export class NotFound extends Error { constructor(m) { super(m); this.name = "NotFound"; } }

// ---------------------------------------------------------------- dates et identifiants
const pad = n => String(n).padStart(2, "0");
export const localISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const nowIso = (d = new Date()) => `${localISO(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const parseISO = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return localISO(d); };
export function newId(prefix) {
  const c = globalThis.crypto;
  const raw = c?.randomUUID ? c.randomUUID().replaceAll("-", "") : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${prefix}_${raw.slice(0, 16)}`;
}

// ---------------------------------------------------------------- horloge hybride
// Horodatage « ms.seq.appareil », comparable comme une chaîne. observe() avance l'horloge quand on
// voit un horodatage venu d'ailleurs, pour qu'une modification locale ultérieure gagne toujours.
export class Clock {
  constructor(device) { this.device = device; this.ms = 0; this.seq = 0; }
  now() {
    const t = Date.now();
    if (t > this.ms) { this.ms = t; this.seq = 0; } else this.seq++;
    return this.fmt();
  }
  fmt() { return `${String(this.ms).padStart(15, "0")}.${String(this.seq).padStart(5, "0")}.${this.device}`; }
  observe(stamp) {
    if (typeof stamp !== "string") return;
    const [ms, seq] = stamp.split(".").map(Number);
    if (!Number.isFinite(ms) || !Number.isFinite(seq)) return;
    if (ms > this.ms || (ms === this.ms && seq > this.seq)) { this.ms = ms; this.seq = seq; }
  }
}
export const stampMs = s => Number(String(s).split(".")[0]) || 0;
// Horodatage dérivé, juste après `base` et identique sur tous les appareils (actions automatiques).
const derived = (base, tag) => `${base || "0".repeat(15) + ".00000.0"}~${tag}`;

// ---------------------------------------------------------------- fusion
const live = r => r && !r._deleted;

export function mergeRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a._deleted || b._deleted) {
    const s = (a._deleted || "") > (b._deleted || "") ? a._deleted : b._deleted;
    return { id: a.id, _deleted: s, _clk: {} };
  }
  const out = { id: a.id, _clk: {} };
  for (const f of new Set([...Object.keys(a._clk), ...Object.keys(b._clk)])) {
    const sa = a._clk[f] || "", sb = b._clk[f] || "";
    // à horodatage égal, départage déterministe par la valeur : les deux appareils convergent
    const useB = sb > sa || (sb === sa && canonical(b[f] ?? null) > canonical(a[f] ?? null));
    const src = useB ? b : a;
    out[f] = src[f] === undefined ? null : src[f];
    out._clk[f] = useB ? sb : sa;
  }
  return out;
}

// JSON à clés triées : deux contenus identiques donnent la même chaîne.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v === undefined ? null : v);
}

function validRemote(rec, id) {
  return rec && typeof rec === "object" && rec.id === id && /^[\w~-]{1,100}$/.test(id) && rec._clk && typeof rec._clk === "object"
    && Object.values(rec._clk).every(s => typeof s === "string");
}

// ---------------------------------------------------------------- validation
function text(v, field, max) {
  if (typeof v !== "string" || !v.trim()) throw new ValidationError(`« ${field} » ne peut pas être vide.`);
  v = v.trim();
  if (v.length > max) throw new ValidationError(`« ${field} » dépasse ${max} caractères.`);
  return v;
}
function dateV(v, field) {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || localISO(parseISO(v)) !== v)
    throw new ValidationError(`Date invalide pour « ${field} » : ${JSON.stringify(v)}.`);
  return v;
}
function timeV(v, field) {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v))
    throw new ValidationError(`Heure invalide pour « ${field} » : ${JSON.stringify(v)}.`);
  return v;
}
function intV(v, field, lo, hi, nullable = false) {
  if (v == null && nullable) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
    throw new ValidationError(`« ${field} » doit être un entier entre ${lo} et ${hi}.`);
  return v;
}
function numV(v, field) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError(`« ${field} » doit être un nombre.`);
  return v;
}
function idV(v, field, nullable = false) {
  if (v == null && nullable) return null;
  if (typeof v !== "string" || !/^[\w-]{1,64}$/.test(v)) throw new ValidationError(`Identifiant invalide pour « ${field} ».`);
  return v;
}
function colorV(v) {
  if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new ValidationError(`Couleur invalide : ${JSON.stringify(v)}.`);
  return v;
}
const TASK_V = {
  title: v => text(v, "titre", 500),
  project_id: v => idV(v, "projet", true),
  quadrant: v => intV(v, "quadrant", 1, 4),
  due: v => dateV(v, "échéance"),
  estimate: v => intV(v, "durée", 5, 1440),
  planned_date: v => dateV(v, "date planifiée"),
  planned_start: v => timeV(v, "heure planifiée"),
  done: v => intV(v, "terminée", 0, 1),
  sort: v => numV(v, "ordre"),
};
function clean(data, validators, partial) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ValidationError("Requête invalide : objet attendu.");
  const unknown = Object.keys(data).filter(k => !(k in validators));
  if (unknown.length) throw new ValidationError(`Champ(s) inconnu(s) : ${unknown.sort().join(", ")}.`);
  const out = {};
  for (const [k, v] of Object.entries(data)) out[k] = validators[k](v);
  if (!partial && "title" in validators && !("title" in out)) throw new ValidationError("« titre » est obligatoire.");
  return out;
}
const planLabel = f => f.planned_date + (f.planned_start ? ` ${f.planned_start}` : "");
const pub = r => { if (!r) return r; const { _clk, ...rest } = r; return rest; };

// ---------------------------------------------------------------- stockage
export class Store {
  constructor(adapter, { today } = {}) {
    this.adapter = adapter;
    this.today = today || (() => localISO(new Date()));
    this.listeners = new Set();
    this.routes = this._routes();
  }

  async open() {
    this.device = await this.adapter.getMeta("device");
    if (!this.device) {
      this.device = newId("d").slice(2, 10);
      await this.adapter.setMeta("device", this.device);
    }
    this.clock = new Clock(this.device);
    this.clock.observe(await this.adapter.getMeta("clock"));
    await this.reload();
    if (this.db.projects.size === 0) {
      const { id, ...fields } = DEFAULT_PROJECT;
      // horodatage fixe : le projet par défaut est identique sur tous les appareils
      await this.mutate(w => w.put("projects", id, fields, derived("", "default")));
    }
    return this;
  }

  async reload() {
    const all = await this.adapter.loadAll();
    this.db = Object.fromEntries(COLLECTIONS.map(c => [c, new Map()]));
    for (const { col, rec } of all) {
      if (!this.db[col] || !rec?.id) continue;
      this.db[col].set(rec.id, rec);
      for (const s of Object.values(rec._clk || {})) this.clock.observe(s);
      if (rec._deleted) this.clock.observe(rec._deleted);
    }
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind) { for (const fn of this.listeners) { try { fn(kind); } catch (e) { console.error(e); } } }

  get(col, id) { const r = this.db[col].get(id); return live(r) ? r : undefined; }
  all(col) { return [...this.db[col].values()].filter(live); }

  // Toutes les écritures passent par ici : tout ou rien, en mémoire puis dans IndexedDB.
  async mutate(fn) {
    const touched = new Map();
    const remember = (col, id) => {
      const k = `${col}/${id}`;
      if (!touched.has(k)) { const cur = this.db[col].get(id); touched.set(k, { col, id, before: cur ? structuredClone(cur) : null }); }
    };
    const w = {
      put: (col, id, fields, stamp) => {
        const cur = this.db[col].get(id);
        if (cur?._deleted) throw new NotFound(`Élément ${id} supprimé.`);
        remember(col, id);
        const rec = cur ? { ...cur, _clk: { ...cur._clk } } : { id, _clk: {} };
        const s = stamp || this.clock.now();
        for (const [f, v] of Object.entries(fields)) {
          if (f === "id" || f.startsWith("_")) continue;
          if (cur && f in cur._clk && cur[f] === v) continue; // inchangé : on garde l'horodatage
          rec[f] = v === undefined ? null : v;
          rec._clk[f] = s;
        }
        this.db[col].set(id, rec);
        return rec;
      },
      kill: (col, id) => {
        if (!this.db[col].has(id)) return;
        remember(col, id);
        this.db[col].set(id, { id, _deleted: this.clock.now(), _clk: {} });
      },
    };
    let result;
    try {
      result = fn(w);
    } catch (e) {
      this._rollback(touched);
      throw e;
    }
    if (touched.size) {
      const recs = [...touched.values()].map(({ col, id }) => ({ col, rec: this.db[col].get(id) }));
      try {
        await this.adapter.put(recs, { clock: this.clock.fmt() });
      } catch (e) {
        this._rollback(touched);
        throw new Error(`Enregistrement local impossible : ${e?.message || e}`);
      }
      this.emit("local");
    }
    return result;
  }

  _rollback(touched) {
    for (const { col, id, before } of touched.values()) {
      if (before) this.db[col].set(id, before); else this.db[col].delete(id);
    }
  }

  _event(w, taskId, kind, detail = null, id = newId("e"), stamp) {
    w.put("events", id, { task_id: taskId, at: nowIso(), kind, detail, ord: stamp || this.clock.fmt() }, stamp);
  }
  _task(id, includeDeleted = false) {
    const t = this.get("tasks", id);
    if (!t || (t.deleted_at && !includeDeleted)) throw new NotFound("Tâche introuvable.");
    return t;
  }
  _checkProject(pid) {
    if (pid != null && !this.get("projects", pid)) throw new ValidationError("Projet introuvable.");
  }
  _checkNotPast(plannedDate, done) {
    // Une tâche non faite planifiée dans le passé serait aussitôt « reportée » : on refuse.
    if (plannedDate && !done && plannedDate < this.today())
      throw new ValidationError("Impossible de planifier une tâche non terminée dans le passé.");
  }

  // -------- entretien : reports automatiques et corbeille
  async housekeeping() {
    const today = this.today();
    const late = this.all("tasks").filter(t => !t.done && !t.deleted_at && t.planned_date && t.planned_date < today);
    const limit = nowIso(new Date(Date.now() - TRASH_DAYS * 864e5));
    const oldTasks = this.all("tasks").filter(t => t.deleted_at && t.deleted_at < limit);
    const oldNotes = this.all("notes").filter(n => n.deleted_at && n.deleted_at < limit);
    if (!late.length && !oldTasks.length && !oldNotes.length) return 0;
    await this.mutate(w => {
      for (const t of late) {
        // Horodatage dérivé de la planification : deux appareils produisent exactement le même report,
        // et toute modification faite ensuite par l'utilisateur reste prioritaire.
        const s = derived(t._clk.planned_date, "report");
        w.put("tasks", t.id, { carried_from: t.planned_date, planned_date: null, planned_start: null, reports: (t.reports || 0) + 1 }, s);
        this._event(w, t.id, "reported", t.planned_date, `e_rep_${t.id}_${t.planned_date}`, s);
      }
      for (const t of oldTasks) this._purge(w, t.id);
      for (const n of oldNotes) w.kill("notes", n.id);
    });
    return late.length;
  }

  _purge(w, taskId) {
    w.kill("tasks", taskId);
    for (const col of ["subtasks", "notes", "events"])
      for (const r of this.all(col)) if (r.task_id === taskId) w.kill(col, r.id);
  }

  // -------- état complet pour l'interface
  async state() {
    await this.housekeeping();
    const since = addDays(this.today(), -DONE_VISIBLE_DAYS);
    const noteCount = {}, subs = {};
    for (const n of this.all("notes")) if (n.task_id && !n.deleted_at) noteCount[n.task_id] = (noteCount[n.task_id] || 0) + 1;
    for (const s of this.all("subtasks").sort((a, b) => (a.ord > b.ord ? 1 : -1))) (subs[s.task_id] ||= []).push(pub(s));
    const tasks = this.all("tasks")
      .filter(t => !t.deleted_at && (!t.done || (t.done_at || "") >= since))
      .sort((a, b) => a.sort - b.sort || (a.created_at > b.created_at ? 1 : -1))
      .map(t => ({ ...pub(t), project_id: t.project_id && this.get("projects", t.project_id) ? t.project_id : null,
        subtasks: subs[t.id] || [], note_count: noteCount[t.id] || 0 }));
    return {
      today: this.today(),
      projects: this.all("projects").sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name)).map(pub),
      tasks,
      settings: this.settings(),
      trash_count: this.all("tasks").filter(t => t.deleted_at).length,
    };
  }

  // -------- projets
  async createProject(data) {
    const name = text(data?.name, "nom", 80), color = colorV(data?.color ?? "#888780");
    const id = newId("p");
    await this.mutate(w => w.put("projects", id, { name, color, sort: this.all("projects").length }));
    return id;
  }
  async updateProject(id, data) {
    const f = clean(data, { name: v => text(v, "nom", 80), color: colorV, sort: v => intV(v, "ordre", -1e9, 1e9) }, true);
    if (!this.get("projects", id)) throw new NotFound("Projet introuvable.");
    await this.mutate(w => w.put("projects", id, f));
  }
  async deleteProject(id) {
    if (!this.get("projects", id)) throw new NotFound("Projet introuvable.");
    await this.mutate(w => {
      w.kill("projects", id);
      for (const t of this.all("tasks")) if (t.project_id === id) w.put("tasks", t.id, { project_id: null });
    });
  }

  // -------- tâches
  async createTask(data) {
    const f = clean(data, TASK_V, false);
    this._checkProject(f.project_id);
    this._checkNotPast(f.planned_date, f.done);
    if (f.planned_start && !f.planned_date) throw new ValidationError("Une heure planifiée nécessite une date planifiée.");
    const id = newId("t"), now = nowIso();
    const rec = { title: "", project_id: null, quadrant: 2, due: null, estimate: 30, planned_date: null, planned_start: null,
      carried_from: null, reports: 0, done: 0, done_at: null, sort: Date.now() / 1000, created_at: now, updated_at: now,
      deleted_at: null, ...f };
    if (rec.done) rec.done_at = now;
    await this.mutate(w => {
      w.put("tasks", id, rec);
      this._event(w, id, "created");
      if (rec.planned_date) this._event(w, id, "planned", planLabel(rec));
    });
    return id;
  }

  async updateTask(id, data) {
    const f = clean(data, TASK_V, true);
    const old = this._task(id);
    if ("project_id" in f) this._checkProject(f.project_id);
    const done = "done" in f ? f.done : old.done;
    if (f.planned_date && f.planned_date !== old.planned_date) this._checkNotPast(f.planned_date, done);
    if ("planned_date" in f && f.planned_date === null) f.planned_start = null;
    if (f.planned_start && !("planned_date" in f ? f.planned_date : old.planned_date))
      throw new ValidationError("Une heure planifiée nécessite une date planifiée.");
    if (f.planned_date) f.carried_from = null;
    await this.mutate(w => {
      if ("done" in f && f.done !== old.done) {
        f.done_at = f.done ? nowIso() : null;
        this._event(w, id, f.done ? "done" : "reopened");
      }
      const plan = { planned_date: "planned_date" in f ? f.planned_date : old.planned_date,
        planned_start: "planned_start" in f ? f.planned_start : old.planned_start };
      if (plan.planned_date !== old.planned_date || plan.planned_start !== old.planned_start)
        plan.planned_date ? this._event(w, id, "planned", planLabel(plan)) : this._event(w, id, "unplanned");
      if ("quadrant" in f && f.quadrant !== old.quadrant) this._event(w, id, "quadrant", `${old.quadrant}→${f.quadrant}`);
      if ("title" in f && f.title !== old.title) this._event(w, id, "renamed", old.title);
      w.put("tasks", id, { ...f, updated_at: nowIso() });
    });
  }

  async deleteTask(id) {
    this._task(id);
    await this.mutate(w => { w.put("tasks", id, { deleted_at: nowIso() }); this._event(w, id, "deleted"); });
  }
  async restoreTask(id) {
    const t = this._task(id, true);
    if (!t.deleted_at) return;
    await this.mutate(w => {
      w.put("tasks", id, { deleted_at: null, ...(t.project_id && !this.get("projects", t.project_id) ? { project_id: null } : {}) });
      this._event(w, id, "restored");
    });
  }
  async purgeTask(id) {
    const t = this._task(id, true);
    if (!t.deleted_at) throw new ValidationError("Seule une tâche dans la corbeille peut être supprimée définitivement.");
    await this.mutate(w => this._purge(w, id));
  }
  trash() {
    const noteCount = {};
    for (const n of this.all("notes")) if (!n.deleted_at) noteCount[n.task_id] = (noteCount[n.task_id] || 0) + 1;
    return this.all("tasks").filter(t => t.deleted_at).sort((a, b) => (a.deleted_at < b.deleted_at ? 1 : -1))
      .map(t => ({ ...pub(t), note_count: noteCount[t.id] || 0 }));
  }
  events(taskId) {
    return this.all("events").filter(e => e.task_id === taskId)
      .sort((a, b) => (a.at === b.at ? (a.ord < b.ord ? 1 : -1) : a.at < b.at ? 1 : -1)).map(pub);
  }

  // -------- sous-tâches
  async createSubtask(data) {
    const taskId = idV(data?.task_id, "tâche"), title = text(data?.title, "titre", 300);
    this._task(taskId);
    const id = newId("s");
    await this.mutate(w => w.put("subtasks", id, { task_id: taskId, title, done: 0, ord: this.clock.fmt() }));
    return id;
  }
  async updateSubtask(id, data) {
    const f = clean(data, { title: v => text(v, "titre", 300), done: v => intV(v, "terminée", 0, 1) }, true);
    if (!this.get("subtasks", id)) throw new NotFound("Sous-tâche introuvable.");
    await this.mutate(w => w.put("subtasks", id, f));
  }
  async deleteSubtask(id) {
    if (!this.get("subtasks", id)) throw new NotFound("Sous-tâche introuvable.");
    await this.mutate(w => w.kill("subtasks", id));
  }

  // -------- notes
  notes(taskId) {
    const sortDesc = (a, b) => (a.created_at === b.created_at ? (a.ord < b.ord ? 1 : -1) : a.created_at < b.created_at ? 1 : -1);
    const ns = this.all("notes").filter(n => !n.deleted_at);
    if (taskId) return ns.filter(n => n.task_id === taskId).sort(sortDesc).map(pub);
    return ns.filter(n => !n.task_id || (this.get("tasks", n.task_id) && !this.get("tasks", n.task_id).deleted_at))
      .sort(sortDesc)
      .map(n => { const t = n.task_id ? this.get("tasks", n.task_id) : null; return { ...pub(n), task_title: t?.title ?? null, project_id: t?.project_id ?? null }; });
  }
  async createNote(data) {
    const body = text(data?.body, "note", 20000), taskId = idV(data?.task_id, "tâche", true);
    if (taskId) this._task(taskId);
    const id = newId("n");
    await this.mutate(w => w.put("notes", id, { task_id: taskId, body, created_at: nowIso(), updated_at: null, deleted_at: null, ord: this.clock.fmt() }));
    return id;
  }
  _note(id, deleted) {
    const n = this.get("notes", id);
    if (!n || !!n.deleted_at !== deleted) throw new NotFound("Note introuvable.");
    return n;
  }
  async updateNote(id, data) {
    const body = text(data?.body, "note", 20000);
    this._note(id, false);
    await this.mutate(w => w.put("notes", id, { body, updated_at: nowIso() }));
  }
  async deleteNote(id) { this._note(id, false); await this.mutate(w => w.put("notes", id, { deleted_at: nowIso() })); }
  async restoreNote(id) { this._note(id, true); await this.mutate(w => w.put("notes", id, { deleted_at: null })); }

  // -------- paramètres (synchronisés)
  settings() { return Object.fromEntries(this.all("settings").map(s => [s.id, s.value])); }
  async updateSettings(data) {
    if (!data || typeof data !== "object") throw new ValidationError("Requête invalide : objet attendu.");
    for (const [k, v] of Object.entries(data)) {
      if (!(k in SETTING_KEYS)) throw new ValidationError(`Paramètre inconnu : ${k}.`);
      if (v !== null && (typeof v !== "string" || v.length > SETTING_KEYS[k])) throw new ValidationError(`Valeur invalide pour ${k}.`);
    }
    const cur = this.settings();
    const h0 = +(data.day_start ?? cur.day_start ?? 7), h1 = +(data.day_end ?? cur.day_end ?? 21);
    if (!(Number.isInteger(h0) && Number.isInteger(h1) && 0 <= h0 && h0 < h1 && h1 <= 24)) throw new ValidationError("Plage horaire invalide.");
    if (data.calendars) {
      let ok = false;
      try { const v = JSON.parse(data.calendars); ok = Array.isArray(v) && v.every(x => typeof x === "string"); } catch {}
      if (!ok) throw new ValidationError("Liste d'agendas invalide.");
    }
    await this.mutate(w => { for (const [k, v] of Object.entries(data)) w.put("settings", k, { value: v }); });
  }

  // -------- synchronisation
  snapshot() {
    return Object.fromEntries(COLLECTIONS.map(c => [c, Object.fromEntries([...this.db[c]].map(([id, r]) => [id, structuredClone(r)]))]));
  }

  // Fusionne des enregistrements venus d'ailleurs (Drive, import). Renvoie le nombre de changements locaux.
  async applyRemote(remote) {
    const changed = [], removed = [];
    const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5;
    for (const col of COLLECTIONS) {
      const r = remote && typeof remote[col] === "object" && remote[col] ? remote[col] : {};
      for (const id of new Set([...this.db[col].keys(), ...Object.keys(r)])) {
        const l = this.db[col].get(id);
        let rr = r[id];
        if (rr !== undefined && !validRemote(rr, id)) { console.warn("Enregistrement distant ignoré", col, id); rr = undefined; }
        if (rr) { for (const s of Object.values(rr._clk)) this.clock.observe(s); if (rr._deleted) this.clock.observe(rr._deleted); }
        const m = mergeRecord(l, rr);
        if (!m) continue; // enregistrement distant invalide et inconnu ici
        if (m._deleted && stampMs(m._deleted) < cutoff) { if (l) removed.push({ col, id }); continue; }
        if (!l || canonical(m) !== canonical(l)) changed.push({ col, rec: m });
      }
    }
    if (!changed.length && !removed.length) return 0;
    const before = changed.map(({ col, rec }) => ({ col, id: rec.id, prev: this.db[col].get(rec.id) }));
    for (const { col, rec } of changed) this.db[col].set(rec.id, rec);
    for (const { col, id } of removed) this.db[col].delete(id);
    try {
      await this.adapter.put(changed, { clock: this.clock.fmt() });
      if (removed.length) await this.adapter.remove(removed);
    } catch (e) {
      for (const { col, id, prev } of before) prev ? this.db[col].set(id, prev) : this.db[col].delete(id);
      await this.reload();
      throw new Error(`Enregistrement local impossible : ${e?.message || e}`);
    }
    this.emit("remote");
    return changed.length + removed.length;
  }

  // Restauration d'une sauvegarde : l'état devient exactement celui de la sauvegarde, sur tous les appareils.
  async replaceAll(records) {
    if (!records || typeof records !== "object") throw new ValidationError("Sauvegarde invalide.");
    await this.mutate(w => {
      for (const col of COLLECTIONS) {
        const snap = records[col] || {};
        for (const r of this.all(col)) if (!live(snap[r.id])) w.kill(col, r.id);
        for (const [id, r] of Object.entries(snap)) {
          if (!live(r) || !validRemote(r, id)) continue;
          if (this.db[col].get(id)?._deleted) continue; // supprimé définitivement depuis
          const { id: _, _clk, ...fields } = r;
          w.put(col, id, fields, undefined);
          const rec = this.db[col].get(id); // forcer de nouveaux horodatages : la sauvegarde doit gagner
          const s = this.clock.now();
          for (const f of Object.keys(fields)) rec._clk[f] = s;
        }
      }
    });
  }

  exportAll() {
    return { format: "pypriority-pwa", version: 1, exported_at: new Date().toISOString(), device: this.device, records: this.snapshot() };
  }

  async importData(data) {
    if (data?.format === "pypriority-pwa" || data?.format === "pypriority-sync") {
      const n = await this.applyRemote(data.records);
      return { mode: "fusion", changes: n };
    }
    if (data && typeof data.schema_version === "number" && Array.isArray(data.tasks)) return this._importV2(data);
    throw new ValidationError("Fichier non reconnu : export JSON de pyPriority attendu.");
  }

  async _importV2(d) {
    const counts = { projects: 0, tasks: 0, subtasks: 0, notes: 0, events: 0 };
    const exists = (col, id) => this.db[col].has(id);
    const byName = new Map(this.all("projects").map(p => [p.name.toLowerCase(), p.id]));
    const pmap = {};
    await this.mutate(w => {
      for (const p of d.projects || []) {
        const known = byName.get(String(p.name).toLowerCase());
        if (known) { pmap[p.id] = known; continue; }
        const id = `v2p_${p.id}`; pmap[p.id] = id;
        if (exists("projects", id)) continue;
        w.put("projects", id, { name: String(p.name).slice(0, 80), color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : "#888780", sort: p.sort || 0 });
        counts.projects++;
      }
      for (const t of d.tasks || []) {
        const id = `v2t_${t.id}`;
        if (exists("tasks", id)) continue;
        w.put("tasks", id, {
          title: String(t.title || "(sans titre)").slice(0, 500), project_id: t.project_id != null ? pmap[t.project_id] ?? null : null,
          quadrant: [1, 2, 3, 4].includes(t.quadrant) ? t.quadrant : 2, due: t.due || null, estimate: t.estimate || 30,
          planned_date: t.planned_date || null, planned_start: t.planned_start || null, carried_from: t.carried_from || null,
          reports: t.reports || 0, done: t.done ? 1 : 0, done_at: t.done_at || null, sort: typeof t.sort === "number" ? t.sort : 0,
          created_at: t.created_at || nowIso(), updated_at: t.updated_at || t.created_at || nowIso(), deleted_at: t.deleted_at || null,
        });
        counts.tasks++;
      }
      for (const s of d.subtasks || []) {
        const id = `v2s_${s.id}`;
        if (exists("subtasks", id) || !d.tasks.some(t => t.id === s.task_id)) continue;
        w.put("subtasks", id, { task_id: `v2t_${s.task_id}`, title: String(s.title).slice(0, 300), done: s.done ? 1 : 0, ord: String(s.id).padStart(10, "0") });
        counts.subtasks++;
      }
      for (const n of d.notes || []) {
        const id = `v2n_${n.id}`;
        if (exists("notes", id)) continue;
        w.put("notes", id, { task_id: n.task_id != null ? `v2t_${n.task_id}` : null, body: String(n.body), created_at: n.created_at || nowIso(),
          updated_at: n.updated_at || null, deleted_at: n.deleted_at || null, ord: String(n.id).padStart(10, "0") });
        counts.notes++;
      }
      for (const e of d.task_events || []) {
        const id = `v2e_${e.id}`;
        if (exists("events", id)) continue;
        w.put("events", id, { task_id: `v2t_${e.task_id}`, at: e.at, kind: e.kind, detail: e.detail ?? null, ord: String(e.id).padStart(10, "0") });
        counts.events++;
      }
      for (const s of d.settings || []) {
        if (s.key === "day_start" || s.key === "day_end") w.put("settings", s.key, { value: String(s.value) });
      }
    });
    return { mode: "v2", ...counts };
  }

  // -------- routes : mêmes chemins que l'ancienne API HTTP, pour l'interface
  _routes() {
    return {
      "GET state": () => this.state(),
      "PUT settings": (id, q, b) => this.updateSettings(b),
      "GET export": () => this.exportAll(),
      "POST import": (id, q, b) => this.importData(b),
      "POST projects": (id, q, b) => this.createProject(b).then(id => ({ id })),
      "PATCH projects/:id": (id, q, b) => this.updateProject(id, b),
      "DELETE projects/:id": id => this.deleteProject(id),
      "POST tasks": (id, q, b) => this.createTask(b).then(id => ({ id })),
      "PATCH tasks/:id": (id, q, b) => this.updateTask(id, b),
      "DELETE tasks/:id": id => this.deleteTask(id),
      "POST tasks/:id/restore": id => this.restoreTask(id),
      "DELETE tasks/:id/purge": id => this.purgeTask(id),
      "GET tasks/:id/events": id => this.events(id),
      "GET trash": () => this.trash(),
      "POST subtasks": (id, q, b) => this.createSubtask(b).then(id => ({ id })),
      "PATCH subtasks/:id": (id, q, b) => this.updateSubtask(id, b),
      "DELETE subtasks/:id": id => this.deleteSubtask(id),
      "GET notes": (id, q) => this.notes(q.get("task_id")),
      "POST notes": (id, q, b) => this.createNote(b).then(id => ({ id })),
      "PATCH notes/:id": (id, q, b) => this.updateNote(id, b),
      "DELETE notes/:id": id => this.deleteNote(id),
      "POST notes/:id/restore": id => this.restoreNote(id),
    };
  }

  async api(method, path, body) {
    const [p, qs] = path.split("?");
    const parts = p.split("/").filter(Boolean);
    const shape = parts.length === 1 ? parts[0] : parts.length === 2 ? `${parts[0]}/:id` : `${parts[0]}/:id/${parts[2]}`;
    const fn = this.routes[`${method} ${shape}`];
    if (!fn) throw new NotFound(`${method} ${path} : route inconnue.`);
    const r = await fn(parts[1] && decodeURIComponent(parts[1]), new URLSearchParams(qs || ""), body);
    return r === undefined ? { ok: true } : structuredClone(r);
  }
}

// ---------------------------------------------------------------- adaptateurs de stockage
export class IDBAdapter {
  static open(name = "pypriority") {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("records", { keyPath: "k" });
        req.result.createObjectStore("meta");
      };
      req.onsuccess = () => resolve(new IDBAdapter(req.result));
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("Base locale bloquée par un autre onglet : ferme les autres onglets de l'appli."));
    });
  }
  constructor(db) { this.db = db; db.onversionchange = () => db.close(); }
  _tx(stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(stores, mode);
      let out;
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Transaction annulée"));
      out = fn(tx);
    });
  }
  loadAll() {
    return this._tx(["records"], "readonly", tx => {
      const res = [];
      tx.objectStore("records").openCursor().onsuccess = e => {
        const c = e.target.result;
        if (c) { res.push({ col: c.value.col, rec: c.value.rec }); c.continue(); }
      };
      return res;
    });
  }
  put(records, meta = {}) {
    return this._tx(["records", "meta"], "readwrite", tx => {
      const rs = tx.objectStore("records"), ms = tx.objectStore("meta");
      for (const { col, rec } of records) rs.put({ k: `${col}/${rec.id}`, col, rec });
      for (const [k, v] of Object.entries(meta)) ms.put(v, k);
    });
  }
  remove(items) {
    return this._tx(["records"], "readwrite", tx => { for (const { col, id } of items) tx.objectStore("records").delete(`${col}/${id}`); });
  }
  getMeta(key) {
    return this._tx(["meta"], "readonly", tx => {
      const box = {};
      tx.objectStore("meta").get(key).onsuccess = e => { box.v = e.target.result; };
      return box;
    }).then(box => box.v);
  }
  setMeta(key, value) { return this._tx(["meta"], "readwrite", tx => { tx.objectStore("meta").put(value, key); }); }
}

export class MemoryAdapter {
  constructor() { this.records = new Map(); this.meta = new Map(); this.failNext = false; }
  async loadAll() { return [...this.records.values()].map(v => structuredClone(v)); }
  async put(records, meta = {}) {
    if (this.failNext) { this.failNext = false; throw new Error("disque plein (simulé)"); }
    for (const { col, rec } of records) this.records.set(`${col}/${rec.id}`, structuredClone({ col, rec }));
    for (const [k, v] of Object.entries(meta)) this.meta.set(k, v);
  }
  async remove(items) { for (const { col, id } of items) this.records.delete(`${col}/${id}`); }
  async getMeta(k) { return this.meta.get(k); }
  async setMeta(k, v) { this.meta.set(k, v); }
}
