// Événements Google Agenda répartis par jour, avec cache local pour l'affichage hors ligne.
import { NeedsAuth, Offline } from "./google.js";
import { addDays, localISO } from "./store.js";

const pad = n => String(n).padStart(2, "0");
const parseLocal = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const MEM_TTL = 5 * 60_000;

// items : événements de l'API Google Agenda (singleEvents=true). Renvoie { "AAAA-MM-JJ": [événements] }.
export function bucketEvents(items, days) {
  const out = Object.fromEntries(days.map(d => [d, []]));
  for (const it of items) {
    if (!it || it.status === "cancelled" || it.eventType === "workingLocation") continue;
    if (it.attendees?.some(a => a.self && a.responseStatus === "declined")) continue;
    const title = it.summary || "(sans titre)";
    // informations pour l'édition (identifiant, agenda, horaires d'origine, droits)
    const invitee = it.attendees?.some(a => a.self) && !it.organizer?.self && !it.guestsCanModify;
    const meta = {
      id: it.id, cal: it._cal, link: it.htmlLink || null, location: it.location || "", description: it.description || "",
      recurring: !!it.recurringEventId, guests: (it.attendees || []).filter(a => !a.self).length,
      canEdit: !!it.id && !!it._cal && ["owner", "writer"].includes(it._access) && !invitee,
    };
    if (it.start?.date) { // journée entière ; date de fin exclusive
      const s = it.start.date, e = it.end?.date && it.end.date > s ? it.end.date : addDays(s, 1);
      for (const d of days) if (d >= s && d < e) out[d].push({ title, allday: true, start: "00:00", minutes: 1440, s, e, ...meta });
      continue;
    }
    if (!it.start?.dateTime) continue;
    const s = new Date(it.start.dateTime);
    let e = new Date(it.end?.dateTime || s.getTime() + 3600e3);
    if (!(e > s)) e = new Date(s.getTime() + 15 * 60e3);
    for (const d of days) {
      const ds = parseLocal(d), de = parseLocal(addDays(d, 1));
      const a = Math.max(s, ds), b = Math.min(e, de);
      if (b <= a) continue; // un événement sur plusieurs jours apparaît sur chacun
      const start = new Date(a);
      out[d].push({ title, allday: false, start: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
        minutes: Math.max(15, Math.round((b - a) / 60e3)), s: s.toISOString(), e: e.toISOString(),
        split: a > s || b < e, ...meta });
    }
  }
  for (const d of days) out[d].sort((x, y) => (x.allday === y.allday ? (x.start < y.start ? -1 : 1) : x.allday ? -1 : 1));
  return out;
}

const plain = html => String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n")
  .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();

// Événements Google → tâches candidates pour l'import (aperçu, puis store.importTasks).
// Les événements passés deviennent des tâches terminées (historique, sans report automatique).
export function eventsToTasks(items, { calendarId, today }) {
  const out = [];
  for (const it of items) {
    if (!it?.id || it.status === "cancelled" || it.eventType === "workingLocation") continue;
    if (it.attendees?.some(a => a.self && a.responseStatus === "declined")) continue;
    const title = (it.summary || "(sans titre)").slice(0, 500);
    const noteParts = [];
    if (it.location) noteParts.push(`Lieu : ${it.location}`);
    if (it.description) noteParts.push(plain(it.description));
    let planned_date, planned_start = null, estimate, past;
    if (it.start?.date) {
      planned_date = it.start.date;
      estimate = 60;
      const end = it.end?.date && it.end.date > planned_date ? it.end.date : addDays(planned_date, 1);
      past = end <= today;
      if (addDays(planned_date, 1) < end) noteParts.unshift(`Événement sur plusieurs jours, jusqu'au ${addDays(end, -1)}.`);
      if (!past && planned_date < today) planned_date = today; // en cours : planifié aujourd'hui
    } else if (it.start?.dateTime) {
      const s = new Date(it.start.dateTime), e = new Date(it.end?.dateTime || s.getTime() + 3600e3);
      planned_date = localISO(s);
      planned_start = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
      estimate = Math.min(1440, Math.max(5, Math.round((e - s) / 60e3 / 5) * 5 || 5));
      past = planned_date < today; // même règle que la planification : un jour passé = terminé
    } else continue;
    out.push({
      source: `gcal:${calendarId}:${it.id}`,
      title, planned_date, planned_start, estimate, done: past ? 1 : 0,
      note: noteParts.join("\n\n") || null,
      recurring: !!it.recurringEventId, guests: (it.attendees || []).filter(a => !a.self).length, allday: !!it.start.date,
    });
  }
  return out.sort((a, b) => (a.planned_date + (a.planned_start || "")).localeCompare(b.planned_date + (b.planned_start || "")));
}

export class CalendarService {
  constructor(store, google) {
    this.store = store;
    this.google = google;
    this.mem = new Map();
  }
  invalidate() { this.mem.clear(); }
  mode() { return this.store.settings().calendar_mode === "local" ? "local" : "live"; }
  selected() {
    try {
      const v = JSON.parse(this.store.settings().calendars ?? '["primary"]');
      return Array.isArray(v) ? v : ["primary"];
    } catch { return ["primary"]; }
  }

  async range(start, n) {
    const days = Array.from({ length: n }, (_, i) => addDays(start, i));
    const result = by => ({ days: days.map(date => ({ date, events: by[date] || [] })) });
    if (!this.google.enabled() || this.mode() === "local") return { ...result({}), warning: null };
    const ids = this.selected();
    if (!ids.length) return { ...result({}), warning: null };
    const key = `${days[0]}|${n}|${ids.join(",")}`;
    const hit = this.mem.get(key);
    if (hit && Date.now() - hit.at < MEM_TTL) return hit.data;
    try {
      if (!this.google.token()) throw new NeedsAuth("connexion Google à renouveler");
      if (!this.google.hasCalendar())
        return { ...result({}), warning: "Accès à l'agenda non autorisé : reconnecte Google (Paramètres) en cochant l'agenda." };
      const timeMin = parseLocal(days[0]).toISOString(), timeMax = parseLocal(addDays(days.at(-1), 1)).toISOString();
      const access = await this.accessRoles();
      const lists = await Promise.all(ids.map(id => this.google.events(id, timeMin, timeMax)
        .then(items => items.map(it => ({ ...it, _cal: id, _access: access[id] || "reader" }))).catch(e => {
        if (e instanceof NeedsAuth || e instanceof Offline) throw e;
        console.warn(`Agenda ${id} ignoré :`, e);
        return [];
      })));
      const by = bucketEvents(lists.flat(), days);
      const data = { ...result(by), warning: null };
      this.mem.set(key, { at: Date.now(), data });
      await this._saveCache(by);
      return data;
    } catch (e) {
      const cache = (await this.store.adapter.getMeta("calcache")) || {};
      const known = days.some(d => cache[d]);
      const why = e instanceof NeedsAuth ? "connexion Google à renouveler (touche l'indicateur de synchronisation)"
        : e instanceof Offline ? "hors ligne" : e.message;
      return {
        days: days.map(date => ({ date, events: cache[date]?.events || [] })),
        warning: `Agenda non actualisé : ${why}.${known ? " Dernière version connue affichée." : ""}`,
      };
    }
  }

  // Droits sur chaque agenda (lecture seule, ou modification possible), mémorisés.
  async accessRoles() {
    if (this._access && Date.now() - this._access.at < 60 * 60_000) return this._access.map;
    let map = (await this.store.adapter.getMeta("calaccess")) || {};
    try {
      map = Object.fromEntries((await this.google.calendars()).map(c => [c.id, c.access]));
      await this.store.adapter.setMeta("calaccess", map);
    } catch (e) {
      if (e instanceof NeedsAuth || e instanceof Offline) throw e;
    }
    this._access = { at: Date.now(), map };
    return map;
  }

  async _saveCache(by) {
    const cache = (await this.store.adapter.getMeta("calcache")) || {};
    const at = new Date().toISOString();
    for (const [d, events] of Object.entries(by)) cache[d] = { at, events };
    const today = localISO(new Date()), lo = addDays(today, -31), hi = addDays(today, 120);
    for (const d of Object.keys(cache)) if (d < lo || d > hi) delete cache[d];
    await this.store.adapter.setMeta("calcache", cache);
  }
}
