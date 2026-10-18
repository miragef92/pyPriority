// Connexion Google (Google Identity Services) et accès REST à Drive (dossier caché de l'appli) et Agenda.
import { GOOGLE_CLIENT_ID } from "./config.js";

export class NeedsAuth extends Error { constructor(m) { super(m); this.name = "NeedsAuth"; } }
export class Offline extends Error { constructor(m) { super(m); this.name = "Offline"; } }

const SCOPE_DRIVE = "https://www.googleapis.com/auth/drive.appdata";
const SCOPE_CAL = "https://www.googleapis.com/auth/calendar.readonly";
const SCOPE_CAL_W = "https://www.googleapis.com/auth/calendar.events";
const SCOPES = [SCOPE_DRIVE, SCOPE_CAL, SCOPE_CAL_W, "openid", "email"].join(" ");
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const CAL = "https://www.googleapis.com/calendar/v3";
const K = { token: "g:token", connected: "g:connected", email: "g:email" };

const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Google {
  constructor(clientId = GOOGLE_CLIENT_ID) {
    const override = lsGet("g:client_id"); // permet de tester sans modifier config.js
    this.clientId = (override || clientId || "").trim();
    this._gis = null;
  }
  configured() { return !!this.clientId; }
  enabled() { return this.configured() && lsGet(K.connected) === "1"; }
  email() { return lsGet(K.email); }
  token() {
    try {
      const t = JSON.parse(lsGet(K.token) || "null");
      return t && t.expires_at > Date.now() + 60_000 ? t : null;
    } catch { return null; }
  }
  hasCalendar() { return !!this.token()?.calendar; }
  canWriteCalendar() { return !!this.token()?.calendarWrite; }

  // Script Google chargé à l'avance : la fenêtre de connexion doit s'ouvrir juste après un clic.
  preload() { if (this.configured() && navigator.onLine) this.loadGis().catch(() => {}); }
  loadGis() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    this._gis ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { this._gis = null; s.remove(); reject(new Offline("Impossible de joindre Google (hors ligne ?).")); };
      document.head.appendChild(s);
    });
    return this._gis;
  }

  _requestToken(prompt) {
    return new Promise((resolve, reject) => {
      const oauth2 = window.google.accounts.oauth2;
      const client = oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPES,
        prompt,
        hint: this.email() || undefined,
        callback: resp => {
          if (resp.error) return reject(new NeedsAuth(resp.error_description || resp.error));
          if (!oauth2.hasGrantedAllScopes(resp, SCOPE_DRIVE))
            return reject(new NeedsAuth("L'accès à Google Drive est nécessaire pour synchroniser. Reconnecte-toi en cochant Drive."));
          const tok = {
            access_token: resp.access_token,
            expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
            calendar: oauth2.hasGrantedAllScopes(resp, SCOPE_CAL),
            calendarWrite: oauth2.hasGrantedAllScopes(resp, SCOPE_CAL_W),
          };
          lsSet(K.token, JSON.stringify(tok));
          resolve(tok);
        },
        error_callback: err => reject(new NeedsAuth(
          err?.type === "popup_closed" ? "Connexion Google annulée."
            : err?.type === "popup_failed_to_open" ? "La fenêtre de connexion Google a été bloquée. Touche « Reconnecter Google »."
              : `Connexion Google impossible (${err?.message || err?.type || "erreur inconnue"}).`)),
      });
      client.requestAccessToken();
    });
  }

  // Première connexion (à appeler depuis un clic).
  async connect() {
    if (!this.configured()) throw new NeedsAuth("Identifiant client Google manquant : voir le guide d'installation.");
    await this.loadGis();
    await this._requestToken("select_account");
    const info = await (await this.fetch("https://www.googleapis.com/oauth2/v3/userinfo")).json();
    lsSet(K.email, info.email || "");
    lsSet(K.connected, "1");
  }

  // Jeton valide garanti ; si `interactive`, peut ouvrir brièvement la fenêtre Google (depuis un clic).
  async ensureToken({ interactive = false } = {}) {
    if (this.token()) return;
    if (!interactive) throw new NeedsAuth("Connexion Google à renouveler.");
    await this.loadGis();
    await this._requestToken("");
  }

  // Demande l'accès en écriture à l'agenda (depuis un clic).
  async upgradeCalendar() {
    await this.loadGis();
    const tok = await this._requestToken("consent");
    if (!tok.calendarWrite) throw new NeedsAuth("Modification de l'agenda non autorisée : coche l'accès « Afficher et modifier les événements ».");
  }

  disconnect() {
    const t = this.token();
    try { if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t.access_token, () => {}); } catch {}
    lsSet(K.token, null); lsSet(K.connected, null); lsSet(K.email, null);
  }

  async fetch(url, opts = {}, retries = 2) {
    const t = this.token();
    if (!t) throw new NeedsAuth("Connexion Google à renouveler.");
    let r;
    try {
      r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t.access_token}` } });
    } catch {
      throw new Offline("Hors ligne.");
    }
    if (r.status === 401) { lsSet(K.token, null); throw new NeedsAuth("Connexion Google expirée."); }
    if ((r.status === 429 || r.status >= 500 || r.status === 403) && retries > 0) {
      const body = r.status === 403 ? await r.clone().text() : "";
      if (r.status !== 403 || /rateLimit|userRateLimit|quota/i.test(body)) {
        await sleep(1000 * (3 - retries) + Math.random() * 500);
        return this.fetch(url, opts, retries - 1);
      }
    }
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).error?.message || msg; } catch {}
      throw new Error(`Google ${r.status} : ${msg}`);
    }
    return r;
  }

  // -------- Drive (dossier caché appDataFolder : invisible dans Drive, accessible à cette appli seulement)
  async list(query) {
    const files = [];
    let page = "";
    do {
      const q = encodeURIComponent(`${query} and trashed=false`);
      const r = await (await this.fetch(`${DRIVE}/files?spaces=appDataFolder&q=${q}&pageSize=1000&orderBy=modifiedTime desc` +
        `&fields=nextPageToken,files(id,name,modifiedTime,size)${page ? `&pageToken=${page}` : ""}`)).json();
      files.push(...(r.files || []));
      page = r.nextPageToken || "";
    } while (page);
    return files;
  }
  async download(id) { return (await this.fetch(`${DRIVE}/files/${id}?alt=media`)).text(); }
  async create(name, text) {
    const boundary = "pyp" + Math.random().toString(36).slice(2);
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name, parents: ["appDataFolder"], mimeType: "application/json" }) +
      `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
    const r = await this.fetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name,modifiedTime`, {
      method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
    });
    return r.json();
  }
  async update(id, text) {
    const r = await this.fetch(`${UPLOAD}/files/${id}?uploadType=media&fields=id,modifiedTime`, {
      method: "PATCH", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: text,
    });
    return r.json();
  }
  async remove(id) { await this.fetch(`${DRIVE}/files/${id}`, { method: "DELETE" }); }

  // -------- Agenda (lecture seule)
  async calendars() {
    const r = await (await this.fetch(`${CAL}/users/me/calendarList?minAccessRole=reader&fields=items(id,summary,primary,backgroundColor,accessRole)`)).json();
    return (r.items || []).map(c => ({ id: c.primary ? "primary" : c.id, name: c.summary, color: c.backgroundColor, primary: !!c.primary, access: c.accessRole }));
  }
  async events(calendarId, timeMin, timeMax) {
    const items = [];
    let page = "";
    do {
      const r = await (await this.fetch(`${CAL}/calendars/${encodeURIComponent(calendarId)}/events?singleEvents=true&orderBy=startTime` +
        `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=2500` +
        `&fields=nextPageToken,items(id,summary,status,start,end,transparency,eventType,htmlLink,location,description,recurringEventId,guestsCanModify,organizer(self),attendees(self,responseStatus))` +
        `${page ? `&pageToken=${page}` : ""}`)).json();
      items.push(...(r.items || []));
      page = r.nextPageToken || "";
    } while (page);
    return items;
  }

  async patchEvent(calendarId, eventId, body, sendUpdates = "none") {
    const r = await this.fetch(`${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`, {
      method: "PATCH", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body),
    }, 0);
    return r.json();
  }
  async deleteEvent(calendarId, eventId, sendUpdates = "none") {
    await this.fetch(`${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=${sendUpdates}`,
      { method: "DELETE" }, 0);
  }
}
