// Tests de l'appli web : ouvrir tests.html (servi en local). Aucune donnée réelle n'est touchée.
import { Store, MemoryAdapter, mergeRecord, canonical, Clock, ValidationError, NotFound, addDays, TOMBSTONE_DAYS } from "./store.js";
import { Sync, DATA_FILE, FORMAT } from "./sync.js";
import { bucketEvents } from "./calendar.js";
import { NeedsAuth, Offline } from "./google.js";

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e }); console.error(name, e); }
}
function eq(a, b, msg = "") {
  if (canonical(a) !== canonical(b)) throw new Error(`${msg} attendu ${JSON.stringify(b)}, obtenu ${JSON.stringify(a)}`);
}
function ok(v, msg = "assertion fausse") { if (!v) throw new Error(msg); }
async function throws(fn, cls, re) {
  try { await fn(); } catch (e) {
    if (cls && !(e instanceof cls)) throw new Error(`erreur inattendue : ${e}`);
    if (re && !re.test(e.message)) throw new Error(`message inattendu : ${e.message}`);
    return e;
  }
  throw new Error("aucune erreur levée");
}

let DAY = "2026-10-10";
const mkStore = async (adapter = new MemoryAdapter()) => new Store(adapter, { today: () => DAY }).open();
const task = (s, extra = {}) => s.createTask({ title: "T", ...extra });
const view = s => { const snap = s.snapshot(); return canonical(snap); };

// Faux Google Drive partagé entre plusieurs « appareils ».
class FakeCloud { constructor() { this.files = new Map(); this.n = 0; this.tick = 0; } }
class FakeDrive {
  constructor(cloud) { this.cloud = cloud; this.on = true; this.authed = true; this.offline = false; this.calls = []; }
  enabled() { return this.on; }
  async ensureToken({ interactive } = {}) { if (!this.authed) { if (!interactive) throw new NeedsAuth("jeton expiré"); this.authed = true; } }
  _net() { if (this.offline) throw new Offline("hors ligne"); }
  async list(q) {
    this._net();
    const exact = q.match(/name='([^']+)'/), prefix = q.match(/name contains '([^']+)'/);
    return [...this.cloud.files.entries()]
      .filter(([, f]) => (exact ? f.name === exact[1] : prefix ? f.name.startsWith(prefix[1]) : true))
      .map(([id, f]) => ({ id, name: f.name, modifiedTime: f.modifiedTime }))
      .sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1));
  }
  async download(id) { this._net(); return this.cloud.files.get(id).text; }
  async create(name, text) {
    this._net(); this.calls.push(["create", name]);
    const id = `f${++this.cloud.n}`;
    this.cloud.files.set(id, { name, text, modifiedTime: String(++this.cloud.tick).padStart(8, "0") });
    return { id };
  }
  async update(id, text) {
    this._net(); this.calls.push(["update", id]);
    const f = this.cloud.files.get(id); f.text = text; f.modifiedTime = String(++this.cloud.tick).padStart(8, "0");
    return { id };
  }
  async remove(id) { this._net(); this.calls.push(["remove", id]); this.cloud.files.delete(id); }
}
const dataFiles = cloud => [...cloud.files.values()].filter(f => f.name === DATA_FILE);

// ---------------------------------------------------------------- horloge et fusion
await test("horloge : monotone, et avance après un horodatage distant", () => {
  const c = new Clock("a");
  const s1 = c.now(), s2 = c.now();
  ok(s2 > s1, "monotone");
  c.observe("999999999999999.00003.zz");
  ok(c.now() > "999999999999999.00003.zz", "après observe");
});

await test("fusion : champ par champ, la valeur la plus récente gagne", () => {
  const a = { id: "x", title: "A", quadrant: 1, _clk: { title: "2", quadrant: "1" } };
  const b = { id: "x", title: "B", quadrant: 3, _clk: { title: "1", quadrant: "3" } };
  eq(mergeRecord(a, b), { id: "x", title: "A", quadrant: 3, _clk: { title: "2", quadrant: "3" } });
  eq(mergeRecord(a, b), mergeRecord(b, a), "commutative");
});

await test("fusion : la suppression définitive gagne ; départage déterministe à égalité", () => {
  const a = { id: "x", title: "A", _clk: { title: "5" } }, dead = { id: "x", _deleted: "1", _clk: {} };
  ok(mergeRecord(a, dead)._deleted && mergeRecord(dead, a)._deleted);
  const p = { id: "x", at: "10:00", _clk: { at: "7" } }, q = { id: "x", at: "11:00", _clk: { at: "7" } };
  eq(mergeRecord(p, q), mergeRecord(q, p));
});

// ---------------------------------------------------------------- logique métier
await test("validation des tâches (mêmes règles que la version PC)", async () => {
  const s = await mkStore();
  const bad = [{ title: "" }, { title: "x", quadrant: 5 }, { title: "x", due: "2026-13-01" }, { title: "x", due: "2026-02-30" },
    { title: "x", planned_date: DAY, planned_start: "25:00" }, { title: "x", estimate: 0 }, { title: "x", estimate: "30" },
    { title: "x", hack: 1 }, { title: "x", project_id: "inconnu" }, { quadrant: 1 }, { title: "x", planned_start: "10:00" }];
  for (const d of bad) await throws(() => s.createTask(d), ValidationError);
  eq(s.all("tasks").length, 0, "aucune tâche créée");
});

await test("pas de planification dans le passé (sauf tâche terminée)", async () => {
  const s = await mkStore();
  await throws(() => task(s, { planned_date: "2026-10-09" }), ValidationError, /passé/);
  const id = await task(s);
  await throws(() => s.updateTask(id, { planned_date: "2026-10-01" }), ValidationError);
  await task(s, { planned_date: "2026-10-01", done: 1 });
  await s.updateTask(id, { planned_date: DAY, planned_start: "09:00" });
  await s.updateTask(id, { planned_date: null });
  eq(s.get("tasks", id).planned_start, null, "l'heure part avec la date");
});

await test("historique : création, fin, réouverture, quadrant, renommage", async () => {
  const s = await mkStore();
  const id = await task(s, { title: "Avant" });
  await s.updateTask(id, { done: 1 });
  ok(s.get("tasks", id).done_at);
  await s.updateTask(id, { done: 0, quadrant: 1, title: "Après" });
  eq(s.events(id).map(e => e.kind).sort(), ["created", "done", "quadrant", "renamed", "reopened"].sort());
});

await test("report automatique : idempotent, compteur, puis replanification", async () => {
  const s = await mkStore();
  const id = await task(s, { planned_date: DAY });
  DAY = "2026-10-11";
  try {
    await s.state(); await s.state();
    const t = s.get("tasks", id);
    eq([t.planned_date, t.carried_from, t.reports], [null, "2026-10-10", 1]);
    eq(s.events(id).filter(e => e.kind === "reported").length, 1);
    await s.updateTask(id, { planned_date: DAY });
    eq([s.get("tasks", id).carried_from, s.get("tasks", id).reports], [null, 1]);
  } finally { DAY = "2026-10-10"; }
});

await test("report fait sur deux appareils : résultat identique, sans doublon", async () => {
  const a = await mkStore(), b = await mkStore();
  const id = await task(a, { planned_date: DAY });
  await b.applyRemote(a.snapshot());
  DAY = "2026-10-11";
  try {
    await a.state(); await b.state();
    await a.applyRemote(b.snapshot()); await b.applyRemote(a.snapshot());
    eq(view(a), view(b), "convergence");
    eq(a.get("tasks", id).reports, 1);
    eq(a.events(id).filter(e => e.kind === "reported").length, 1);
  } finally { DAY = "2026-10-10"; }
});

await test("un report automatique sur un appareil en retard n'écrase pas une replanification", async () => {
  const a = await mkStore(), b = await mkStore();
  const id = await task(a, { planned_date: DAY });
  await b.applyRemote(a.snapshot());
  DAY = "2026-10-11";
  try {
    await a.state();                                   // A reporte…
    await a.updateTask(id, { planned_date: DAY, planned_start: "10:00" }); // …puis l'utilisateur replanifie
    await b.state();                                   // B (hors ligne) reporte de son côté
    await b.applyRemote(a.snapshot()); await a.applyRemote(b.snapshot());
    eq([a.get("tasks", id).planned_date, a.get("tasks", id).planned_start], [DAY, "10:00"]);
    eq(view(a), view(b));
  } finally { DAY = "2026-10-10"; }
});

await test("corbeille : supprimer, annuler, purger (notes et sous-tâches comprises)", async () => {
  const s = await mkStore();
  const id = await task(s);
  await s.createNote({ task_id: id, body: "n" });
  await s.createSubtask({ task_id: id, title: "s" });
  await s.deleteTask(id);
  const st = await s.state();
  eq([st.tasks.length, st.trash_count], [0, 1]);
  eq(s.notes().length, 0, "notes masquées");
  await s.restoreTask(id);
  eq((await s.state()).tasks.length, 1);
  await throws(() => s.purgeTask(id), ValidationError);
  await s.deleteTask(id); await s.purgeTask(id);
  eq([s.all("tasks").length, s.all("notes").length, s.all("subtasks").length, s.all("events").length], [0, 0, 0, 0]);
});

await test("corbeille vidée automatiquement après 30 jours", async () => {
  const s = await mkStore();
  const id = await task(s);
  await s.deleteTask(id);
  await s.mutate(w => w.put("tasks", id, { deleted_at: "2020-01-01T00:00:00" }));
  await s.state();
  ok(!s.get("tasks", id), "purgée");
});

await test("notes : modifier, supprimer, restaurer", async () => {
  const s = await mkStore();
  const n = await s.createNote({ body: "libre" });
  await s.updateNote(n, { body: "modifiée" });
  eq(s.notes()[0].body, "modifiée");
  await s.deleteNote(n);
  eq(s.notes().length, 0);
  await s.restoreNote(n);
  eq(s.notes().length, 1);
  await throws(() => s.restoreNote(n), NotFound);
});

await test("projet supprimé : ses tâches restent, sans projet", async () => {
  const s = await mkStore();
  const p = await s.createProject({ name: "Propu", color: "#7F77DD" });
  const id = await task(s, { project_id: p });
  await s.deleteProject(p);
  eq((await s.state()).tasks.find(t => t.id === id).project_id, null);
});

await test("paramètres validés", async () => {
  const s = await mkStore();
  await throws(() => s.updateSettings({ day_start: "20", day_end: "8" }), ValidationError);
  await throws(() => s.updateSettings({ autre: "x" }), ValidationError);
  await throws(() => s.updateSettings({ calendars: "pas du json" }), ValidationError);
  await s.updateSettings({ day_start: "8", calendars: '["primary"]' });
  eq(s.settings().day_start, "8");
});

await test("échec d'écriture locale : rien n'est modifié (tout ou rien)", async () => {
  const ad = new MemoryAdapter(), s = await mkStore(ad);
  const id = await task(s, { title: "Garde" });
  ad.failNext = true;
  await throws(() => s.updateTask(id, { title: "Perdu", quadrant: 1 }), Error, /Enregistrement local impossible/);
  eq([s.get("tasks", id).title, s.get("tasks", id).quadrant], ["Garde", 2]);
  ad.failNext = true;
  await throws(() => task(s, { title: "Jamais" }), Error);
  const fresh = await mkStore(ad);
  eq(fresh.all("tasks").map(t => t.title), ["Garde"], "relu depuis le stockage");
});

await test("données distantes malformées ignorées", async () => {
  const s = await mkStore();
  const n = await s.applyRemote({ tasks: { bad: { id: "autre" }, "x\"><img": { id: "x\"><img", _clk: {} }, ok_1: { id: "ok_1", title: "ok", _clk: { title: "1" } } }, projects: "nimporte" });
  eq(n, 1);
  ok(s.get("tasks", "ok_1"));
});

await test("pierres tombales anciennes nettoyées", async () => {
  const s = await mkStore();
  const old = String(Date.now() - (TOMBSTONE_DAYS + 5) * 864e5).padStart(15, "0") + ".00000.zz";
  await s.applyRemote({ tasks: { t_old: { id: "t_old", _deleted: old, _clk: {} } } });
  ok(!s.db.tasks.has("t_old"));
});

await test("routes de l'API locale ; résultats copiés", async () => {
  const s = await mkStore();
  const { id } = await s.api("POST", "tasks", { title: "Via API" });
  const st = await s.api("GET", "state");
  st.tasks[0].title = "modifié hors du stockage";
  eq(s.get("tasks", id).title, "Via API");
  await throws(() => s.api("GET", "inconnu"), NotFound);
  eq((await s.api("GET", `tasks/${id}/events`))[0].kind, "created");
});

await test("import de l'export pyPriority PC (v2), sans doublon", async () => {
  const s = await mkStore();
  const v2 = { schema_version: 2, projects: [{ id: 1, name: "Perso", color: "#888780" }, { id: 2, name: "Propu", color: "#7F77DD" }],
    tasks: [{ id: 1, title: "Tester ça !", project_id: 1, quadrant: 1, estimate: 30, done: 0, sort: 1, created_at: "2026-10-09T23:58:40", reports: 0 },
      { id: 2, title: "Relire", project_id: 2, quadrant: 2, estimate: 90, done: 0, sort: 2, created_at: "2026-10-09T23:59:00", reports: 0 }],
    subtasks: [{ id: 1, task_id: 2, title: "Courbes", done: 1 }],
    notes: [{ id: 1, task_id: 1, body: "Ma note", created_at: "2026-10-09T23:59:10" }, { id: 2, task_id: null, body: "libre", created_at: "2026-10-09T23:59:20" }],
    task_events: [{ id: 1, task_id: 1, at: "2026-10-09T23:58:40", kind: "created", detail: null }],
    settings: [{ key: "day_start", value: "8" }, { key: "ics_url", value: "https://x" }] };
  const r = await s.importData(v2);
  eq([r.projects, r.tasks, r.subtasks, r.notes], [1, 2, 1, 2]);
  const st = await s.state();
  eq(st.tasks.find(t => t.title === "Tester ça !").project_id, "p_default", "« Perso » réutilisé");
  eq(st.settings.day_start, "8");
  eq(st.settings.ics_url, undefined);
  const again = await s.importData(v2);
  eq([again.tasks, again.notes], [0, 0], "réimport sans doublon");
});

await test("restauration d'une sauvegarde : retour exact à l'état sauvegardé", async () => {
  const s = await mkStore();
  const keep = await task(s, { title: "Ancienne" });
  const snap = s.snapshot();
  await s.updateTask(keep, { title: "Modifiée" });
  const later = await task(s, { title: "Créée après" });
  await s.replaceAll(snap);
  eq(s.get("tasks", keep).title, "Ancienne");
  ok(!s.get("tasks", later), "tâche postérieure retirée");
  const other = await mkStore();
  await other.applyRemote(snap);
  await other.applyRemote(s.snapshot());
  eq(other.get("tasks", keep).title, "Ancienne", "la restauration gagne aussi sur les autres appareils");
});

// ---------------------------------------------------------------- synchronisation Drive
await test("synchro : deux appareils, modifications concurrentes hors ligne, convergence", async () => {
  const cloud = new FakeCloud();
  const pc = await mkStore(), phone = await mkStore();
  const sPc = new Sync(pc, new FakeDrive(cloud)), sPhone = new Sync(phone, new FakeDrive(cloud));
  const id = await task(pc, { title: "Relire rapport" });
  ok(await sPc.run(), "synchro PC");
  ok(await sPhone.run(), "synchro téléphone");
  ok(phone.get("tasks", id), "tâche reçue sur le téléphone");
  // hors ligne, chacun modifie un champ différent de la même tâche
  await pc.updateTask(id, { title: "Relire rapport v2" });
  await phone.updateTask(id, { quadrant: 1 });
  const nPhone = await phone.createNote({ task_id: id, body: "note du téléphone" });
  await sPhone.run(); await sPc.run(); await sPhone.run();
  eq([pc.get("tasks", id).title, pc.get("tasks", id).quadrant], ["Relire rapport v2", 1]);
  ok(pc.get("notes", nPhone), "note reçue");
  eq(view(pc), view(phone), "états identiques");
  eq(dataFiles(cloud).length, 1);
});

await test("synchro : rien à envoyer si rien n'a changé", async () => {
  const cloud = new FakeCloud(), s = await mkStore(), d = new FakeDrive(cloud), sync = new Sync(s, d);
  await task(s);
  await sync.run();
  d.calls = [];
  await sync.run();
  eq(d.calls.filter(c => c[0] === "update").length, 0);
  ok(!sync.dirty);
});

await test("synchro : suppression propagée, sans résurrection", async () => {
  const cloud = new FakeCloud(), a = await mkStore(), b = await mkStore();
  const sa = new Sync(a, new FakeDrive(cloud)), sb = new Sync(b, new FakeDrive(cloud));
  const id = await task(a);
  await sa.run(); await sb.run();
  await a.deleteTask(id); await a.purgeTask(id);
  await b.updateTask(id, { title: "modifiée hors ligne" });
  await sb.run(); await sa.run(); await sb.run();
  ok(!a.get("tasks", id) && !b.get("tasks", id));
});

await test("synchro : deux fichiers créés en même temps sont fusionnés en un", async () => {
  const cloud = new FakeCloud(), a = await mkStore(), b = await mkStore();
  const ta = await task(a, { title: "A" }), tb = await task(b, { title: "B" });
  const da = new FakeDrive(cloud), db = new FakeDrive(cloud);
  await da.create(DATA_FILE, JSON.stringify({ format: FORMAT, version: 1, records: a.snapshot() }));
  await db.create(DATA_FILE, JSON.stringify({ format: FORMAT, version: 1, records: b.snapshot() }));
  const c = await mkStore();
  await new Sync(c, new FakeDrive(cloud)).run();
  ok(c.get("tasks", ta) && c.get("tasks", tb));
  eq(dataFiles(cloud).length, 1);
});

await test("synchro : fichier Drive illisible mis de côté, puis remplacé", async () => {
  const cloud = new FakeCloud(), s = await mkStore(), d = new FakeDrive(cloud);
  await d.create(DATA_FILE, "{pas du json");
  await task(s, { title: "locale" });
  ok(await new Sync(s, d).run());
  ok([...cloud.files.values()].some(f => f.name.startsWith("corrompu-") && f.text === "{pas du json"), "copie gardée");
  ok(JSON.parse(dataFiles(cloud)[0].text).records.tasks, "remplacé par les données locales");
});

await test("synchro : données d'une version plus récente non écrasées", async () => {
  const cloud = new FakeCloud(), s = await mkStore(), d = new FakeDrive(cloud);
  const text = JSON.stringify({ format: FORMAT, version: 99, records: {} });
  await d.create(DATA_FILE, text);
  const sync = new Sync(s, d);
  ok(!(await sync.run()));
  eq(sync.status.state, "error");
  eq(dataFiles(cloud)[0].text, text);
});

await test("synchro : jeton expiré → en attente, données locales intactes ; hors ligne → en attente", async () => {
  const cloud = new FakeCloud(), s = await mkStore(), d = new FakeDrive(cloud), sync = new Sync(s, d);
  d.authed = false;
  await task(s);
  ok(!(await sync.run()));
  eq([sync.status.state, sync.status.pending], ["auth", true]);
  ok(await sync.run({ interactive: true }), "reconnexion depuis un clic");
  eq(sync.status.pending, false);
  d.offline = true;
  await task(s);
  ok(!(await sync.run()));
  eq(sync.status.state, "offline");
  d.offline = false;
  ok(await sync.run());
});

await test("synchro : une sauvegarde par jour, 30 conservées", async () => {
  const cloud = new FakeCloud(), s = await mkStore(), d = new FakeDrive(cloud);
  for (let i = 0; i < 35; i++) await d.create(`backup-2020-01-${String(i).padStart(2, "0")}.json`, "{}");
  const sync = new Sync(s, d);
  await sync.run(); await sync.run();
  const backups = [...cloud.files.values()].filter(f => f.name.startsWith("backup-"));
  eq(backups.length, 30);
  ok(backups.some(f => f.name === `backup-${DAY}.json`));
});

await test("synchro : restauration depuis Drive", async () => {
  const cloud = new FakeCloud(), s = await mkStore(), d = new FakeDrive(cloud), sync = new Sync(s, d);
  const id = await task(s, { title: "v1" });
  await sync.run();
  const backup = [...cloud.files.entries()].find(([, f]) => f.name.startsWith("backup-"))[0];
  await s.updateTask(id, { title: "v2" });
  await sync.restore(backup);
  eq(s.get("tasks", id).title, "v1");
  ok([...cloud.files.values()].some(f => f.name.startsWith("avant-restauration-")));
  eq(JSON.parse(dataFiles(cloud)[0].text).records.tasks[id].title, "v1");
});

// ---------------------------------------------------------------- agenda
await test("agenda : événements répartis par jour", () => {
  const days = ["2026-10-12", "2026-10-13", "2026-10-14"];
  const at = (d, h, m = 0) => new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8), h, m).toISOString();
  const by = bucketEvents([
    { summary: "Réunion", start: { dateTime: at("2026-10-12", 11) }, end: { dateTime: at("2026-10-12", 12) } },
    { summary: "Nuit", start: { dateTime: at("2026-10-12", 23) }, end: { dateTime: at("2026-10-13", 1, 30) } },
    { summary: "Salon", start: { date: "2026-10-13" }, end: { date: "2026-10-15" } },
    { summary: "Refusé", start: { dateTime: at("2026-10-12", 9) }, end: { dateTime: at("2026-10-12", 10) }, attendees: [{ self: true, responseStatus: "declined" }] },
    { summary: "Annulé", status: "cancelled", start: { dateTime: at("2026-10-12", 9) }, end: { dateTime: at("2026-10-12", 10) } },
    { summary: "Rappel", start: { dateTime: at("2026-10-14", 8) }, end: { dateTime: at("2026-10-14", 8) } },
  ], days);
  eq(by["2026-10-12"].map(e => [e.title, e.start, e.minutes]), [["Réunion", "11:00", 60], ["Nuit", "23:00", 60]]);
  eq(by["2026-10-13"].map(e => [e.title, e.allday, e.start]), [["Salon", true, "00:00"], ["Nuit", false, "00:00"]]);
  eq(by["2026-10-14"].map(e => [e.title, e.minutes]), [["Salon", 1440], ["Rappel", 15]]);
});

await test("agenda : droits de modification, invités, horaires d'origine", () => {
  const days = ["2026-10-12", "2026-10-13"];
  const at = (d, h) => new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8), h).toISOString();
  const by = bucketEvents([
    { id: "a", _cal: "c1", _access: "owner", summary: "Mien", start: { dateTime: at("2026-10-12", 9) }, end: { dateTime: at("2026-10-12", 10) },
      attendees: [{ self: true }, { email: "x@y.z" }], organizer: { self: true } },
    { id: "b", _cal: "c1", _access: "owner", summary: "Invité", start: { dateTime: at("2026-10-12", 11) }, end: { dateTime: at("2026-10-12", 12) },
      attendees: [{ self: true }], organizer: { self: false } },
    { id: "c", _cal: "c2", _access: "reader", summary: "Lecture", start: { dateTime: at("2026-10-12", 14) }, end: { dateTime: at("2026-10-12", 15) } },
    { id: "d", _cal: "c1", _access: "writer", summary: "Nuit", start: { dateTime: at("2026-10-12", 23) }, end: { dateTime: at("2026-10-13", 2) } },
  ], days);
  const e = Object.fromEntries(by["2026-10-12"].map(x => [x.id, x]));
  eq([e.a.canEdit, e.a.guests, e.a.cal], [true, 1, "c1"]);
  eq([e.b.canEdit, e.c.canEdit, e.d.canEdit], [false, false, true]);
  eq([e.d.split, e.a.split], [true, false]);
  eq(new Date(e.d.e) - new Date(e.d.s), 3 * 3600e3, "durée d'origine conservée");
  eq(by["2026-10-13"][0].start, "00:00");
});

await test("versions de l'appli et du service worker identiques", async () => {
  const sw = await (await fetch("sw.js", { cache: "no-store" })).text();
  const app = await (await fetch("app.js", { cache: "no-store" })).text();
  const v1 = sw.match(/const VERSION = "([^"]+)"/)[1], v2 = app.match(/const APP_VERSION = "([^"]+)"/)[1];
  eq(v1, v2);
});

// ---------------------------------------------------------------- affichage
const failed = results.filter(r => !r.ok);
document.getElementById("summary").textContent = failed.length
  ? `${failed.length} échec(s) sur ${results.length} tests` : `${results.length} tests réussis`;
document.getElementById("summary").className = failed.length ? "ko" : "ok";
document.getElementById("out").innerHTML = results.map(r =>
  `<div class="${r.ok ? "ok" : "ko"}">${r.ok ? "✓" : "✗"} ${r.name}</div>${r.ok ? "" : `<pre>${String(r.err?.stack || r.err).replace(/</g, "&lt;")}</pre>`}`).join("");
window.__results = { total: results.length, failed: failed.map(r => `${r.name} : ${r.err?.message}`) };
