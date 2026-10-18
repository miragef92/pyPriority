// Synchronisation avec un fichier JSON dans le dossier caché de Google Drive (appDataFolder).
//
// Principe : télécharger → fusionner champ par champ (store.applyRemote) → renvoyer le résultat si
// différent. La fusion est commutative : même si deux appareils envoient en même temps, chacun garde
// ses données en local et la synchronisation suivante rétablit l'ensemble.
import { canonical } from "./store.js";
import { NeedsAuth, Offline } from "./google.js";

export const DATA_FILE = "pypriority-data.json";
export const FORMAT = "pypriority-sync";
export const FORMAT_VERSION = 1;
export const KEEP_BACKUPS = 30;

class NewerFormat extends Error {}

const withLock = fn => (globalThis.navigator?.locks ? navigator.locks.request("pypriority-sync", fn) : fn());
const stampName = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

export class Sync {
  constructor(store, drive, { onStatus = () => {} } = {}) {
    this.store = store;
    this.drive = drive;
    this.onStatus = onStatus;
    this.status = { state: drive.enabled() ? "idle" : "local", at: null, error: null, pending: false };
    this.dirty = false;
    this.seq = 0;
    this.running = null;
    this.again = false;
    this.timer = null;
    store.on(kind => {
      if (kind !== "local") return;
      this.seq++;
      if (!this.dirty) { this.dirty = true; store.adapter.setMeta("dirty", true).catch(() => {}); }
      this._set({});
      this.schedule();
    });
  }

  async init() {
    this.status.at = (await this.store.adapter.getMeta("lastSync")) || null;
    this.dirty = !!(await this.store.adapter.getMeta("dirty"));
    this._set({ state: this.drive.enabled() ? "idle" : "local" });
  }

  _set(patch) {
    Object.assign(this.status, patch, { pending: this.dirty });
    try { this.onStatus({ ...this.status }); } catch (e) { console.error(e); }
  }

  schedule(delay = 2500) {
    if (!this.drive.enabled()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), delay);
  }

  // Lance une synchronisation (une seule à la fois). `interactive` : appelé depuis un clic.
  run({ interactive = false } = {}) {
    if (!this.drive.enabled()) { this._set({ state: "local" }); return Promise.resolve(false); }
    if (this.running) { this.again = true; return this.running; }
    this.running = this._run(interactive).finally(() => {
      this.running = null;
      if (this.again) { this.again = false; this.schedule(300); }
    });
    return this.running;
  }

  async _run(interactive) {
    const seq = this.seq;
    try {
      await this.drive.ensureToken({ interactive });
      this._set({ state: "syncing", error: null });
      await withLock(() => this._sync());
      if (this.seq === seq) { this.dirty = false; await this.store.adapter.setMeta("dirty", false); }
      const at = new Date().toISOString();
      await this.store.adapter.setMeta("lastSync", at);
      this._set({ state: "ok", at });
      return true;
    } catch (e) {
      const offline = e instanceof Offline || globalThis.navigator?.onLine === false;
      const state = e instanceof NeedsAuth ? "auth" : offline ? "offline" : "error";
      if (state === "error") console.error("Synchronisation :", e);
      this._set({ state, error: e?.message || String(e) });
      return false;
    }
  }

  _parse(text) {
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    if (!data || data.format !== FORMAT || typeof data.records !== "object" || !data.records) return null;
    if (data.version > FORMAT_VERSION)
      throw new NewerFormat("Les données de Drive viennent d'une version plus récente de l'appli : recharge la page pour la mettre à jour.");
    return data;
  }

  async _sync() {
    const files = (await this.drive.list(`name='${DATA_FILE}'`))
      .sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1));
    let remote = {};
    for (const [i, f] of files.entries()) {
      const text = await this.drive.download(f.id);
      const data = this._parse(text);
      if (!data) {
        // Fichier illisible : on le met de côté avant de le remplacer, rien n'est perdu.
        await this.drive.create(`corrompu-${stampName()}.json`, text);
        continue;
      }
      if (i === 0) remote = data.records;
      await this.store.applyRemote(data.records);
    }
    const merged = this.store.snapshot();
    if (files.length !== 1 || canonical(merged) !== canonical(remote)) {
      const body = JSON.stringify({ format: FORMAT, version: FORMAT_VERSION, updated_at: new Date().toISOString(),
        device: this.store.device, records: merged });
      if (files.length) await this.drive.update(files[0].id, body);
      else await this.drive.create(DATA_FILE, body);
      for (const f of files.slice(1)) await this.drive.remove(f.id); // doublons déjà fusionnés
    }
    await this._dailyBackup(merged);
  }

  async _dailyBackup(records) {
    const day = this.store.today();
    if ((await this.store.adapter.getMeta("lastBackupDay")) === day) return;
    const name = `backup-${day}.json`;
    const existing = await this.drive.list("name contains 'backup-'");
    if (!existing.some(f => f.name === name))
      await this.drive.create(name, JSON.stringify({ format: FORMAT, version: FORMAT_VERSION, backup_of: day, device: this.store.device, records }));
    const names = [...new Set([...existing.map(f => f.name), name])].sort().reverse();
    const keep = new Set(names.slice(0, KEEP_BACKUPS)), seen = new Set();
    for (const f of existing) {
      if (!keep.has(f.name) || seen.has(f.name)) await this.drive.remove(f.id);
      else seen.add(f.name);
    }
    await this.store.adapter.setMeta("lastBackupDay", day);
  }

  async listBackups() {
    await this.drive.ensureToken({ interactive: true });
    const files = [
      ...await this.drive.list("name contains 'backup-'"),
      ...await this.drive.list("name contains 'avant-restauration-'"),
      ...await this.drive.list("name contains 'corrompu-'"),
    ];
    return files.sort((a, b) => (a.modifiedTime < b.modifiedTime ? 1 : -1));
  }

  // Restaure une sauvegarde Drive, après avoir sauvegardé l'état actuel.
  async restore(fileId) {
    await this.drive.ensureToken({ interactive: true });
    const data = this._parse(await this.drive.download(fileId));
    if (!data) throw new Error("Sauvegarde illisible.");
    await this.drive.create(`avant-restauration-${stampName()}.json`,
      JSON.stringify({ format: FORMAT, version: FORMAT_VERSION, device: this.store.device, records: this.store.snapshot() }));
    await this.store.replaceAll(data.records);
    await this.run({ interactive: true });
  }
}
