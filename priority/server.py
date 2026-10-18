"""Serveur HTTP local : API JSON + fichiers de l'interface."""
import json
import logging
import re
import threading
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import __version__
from .db import NotFound, ValidationError
from .ical import Calendar

log = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}
MAX_BODY = 1024 * 1024
APP_ID = "pypriority"


class Forbidden(Exception):
    pass


def _id(parts, i=1):
    if len(parts) <= i or not parts[i].isdigit():
        raise NotFound("Identifiant manquant.")
    return int(parts[i])


def _day(q):
    try:
        return date.fromisoformat(q.get("date", [""])[0])
    except ValueError:
        raise ValidationError("Paramètre « date » invalide.")


def build_routes(store, calendar, server_ref):
    """Table (méthode, ressource, sous-ressource) → fonction(parts, query, body)."""
    def shutdown(*_):
        threading.Thread(target=server_ref["server"].shutdown, daemon=True).start()
        return {"ok": True}

    def calendar_days(p, q, b):
        start = _day(q)
        try:
            n = int(q.get("days", ["1"])[0])
        except ValueError:
            n = 0
        if not 1 <= n <= 31:
            raise ValidationError("« days » doit être un entier entre 1 et 31.")
        url = store.settings().get("ics_url")
        out, warning = [], None
        for i in range(n):
            d = start + timedelta(days=i)
            events, warning = calendar.for_day(url, d)
            out.append({"date": d.isoformat(), "events": events})
        return {"days": out, "warning": warning}

    def save_settings(p, q, b):
        store.update_settings(b)
        calendar.invalidate()

    return {
        ("GET", "ping", None): lambda p, q, b: {"app": APP_ID, "version": __version__},
        ("GET", "state", None): lambda p, q, b: store.state(),
        ("GET", "calendar", None): calendar_days,
        ("PUT", "settings", None): save_settings,
        ("GET", "backup", None): lambda p, q, b: {"last": store.last_backup()},
        ("POST", "backup", None): lambda p, q, b: {"name": store.backup(force=True), "last": store.last_backup()},
        ("GET", "export", None): lambda p, q, b: store.export_all(),
        ("POST", "shutdown", None): shutdown,

        ("POST", "projects", None): lambda p, q, b: {"id": store.create_project(b)},
        ("PATCH", "projects", "id"): lambda p, q, b: store.update_project(_id(p), b),
        ("DELETE", "projects", "id"): lambda p, q, b: store.delete_project(_id(p)),

        ("POST", "tasks", None): lambda p, q, b: {"id": store.create_task(b)},
        ("PATCH", "tasks", "id"): lambda p, q, b: store.update_task(_id(p), b),
        ("DELETE", "tasks", "id"): lambda p, q, b: store.delete_task(_id(p)),
        ("POST", "tasks", "restore"): lambda p, q, b: store.restore_task(_id(p)),
        ("DELETE", "tasks", "purge"): lambda p, q, b: store.purge_task(_id(p)),
        ("GET", "tasks", "events"): lambda p, q, b: store.events(_id(p)),
        ("GET", "trash", None): lambda p, q, b: store.trash(),

        ("POST", "subtasks", None): lambda p, q, b: {"id": store.create_subtask(b)},
        ("PATCH", "subtasks", "id"): lambda p, q, b: store.update_subtask(_id(p), b),
        ("DELETE", "subtasks", "id"): lambda p, q, b: store.delete_subtask(_id(p)),

        ("GET", "notes", None): lambda p, q, b: store.notes(
            int(q["task_id"][0]) if q.get("task_id", [""])[0].isdigit() else None),
        ("POST", "notes", None): lambda p, q, b: {"id": store.create_note(b)},
        ("PATCH", "notes", "id"): lambda p, q, b: store.update_note(_id(p), b),
        ("DELETE", "notes", "id"): lambda p, q, b: store.delete_note(_id(p)),
        ("POST", "notes", "restore"): lambda p, q, b: store.restore_note(_id(p)),
    }


def _route_key(method, parts):
    """/api/tasks → (tasks, None) ; /api/tasks/3 → (tasks, id) ; /api/tasks/3/restore → (tasks, restore)."""
    res = parts[0] if parts else ""
    if len(parts) == 1:
        return (method, res, None)
    if len(parts) == 2:
        return (method, res, "id")
    if len(parts) == 3:
        return (method, res, parts[2])
    return None


def make_handler(store, calendar, server_ref, port):
    routes = build_routes(store, calendar, server_ref)
    allowed_hosts = {f"localhost:{port}", f"127.0.0.1:{port}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = f"pyPriority/{__version__}"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            log.debug("%s %s", self.address_string(), fmt % args)

        def _send(self, code, body=b"", ctype="application/json; charset=utf-8"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            if ctype.startswith("text/html"):
                self.send_header("Content-Security-Policy",
                                 "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                                 "frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, data, code=200):
            self._send(code, json.dumps(data, ensure_ascii=False).encode("utf-8"))

        def _check_origin(self, method):
            # Bloque les autres sites web (CSRF) et le « DNS rebinding » : seul localhost est accepté.
            if self.headers.get("Host", "") not in allowed_hosts:
                raise Forbidden("Hôte non autorisé.")
            origin = self.headers.get("Origin")
            if origin and re.sub(r"^https?://", "", origin) not in allowed_hosts:
                raise Forbidden("Origine non autorisée.")
            if method in ("POST", "PUT", "PATCH", "DELETE"):
                if not self.headers.get("Content-Type", "").startswith("application/json"):
                    raise Forbidden("Content-Type application/json requis.")

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValidationError("Requête trop volumineuse.")
            raw = self.rfile.read(n) if n else b""
            if not raw:
                return {}
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                raise ValidationError("JSON invalide.")

        def _handle(self, method):
            url = urlparse(self.path)
            try:
                self._check_origin(method)
                if method == "GET" and url.path in STATIC_FILES:
                    name, ctype = STATIC_FILES[url.path]
                    return self._send(200, (STATIC_DIR / name).read_bytes(), ctype)
                parts = [p for p in url.path.split("/") if p]
                if not parts or parts[0] != "api":
                    raise NotFound("Page introuvable.")
                fn = routes.get(_route_key(method, parts[1:]))
                if fn is None:
                    raise NotFound(f"{method} {url.path} : route inconnue.")
                body = self._body() if method in ("POST", "PUT", "PATCH") else None
                result = fn(parts[1:], parse_qs(url.query), body)
                self._json(result if result is not None else {"ok": True})
            except ValidationError as e:
                self._json({"error": str(e)}, 400)
            except Forbidden as e:
                log.warning("Requête refusée (%s) : %s %s", e, method, self.path)
                self._json({"error": str(e)}, 403)
            except NotFound as e:
                self._json({"error": str(e)}, 404)
            except Exception:
                log.exception("Erreur sur %s %s", method, self.path)
                self._json({"error": "Erreur interne, voir priorites.log."}, 500)

        def do_GET(self):
            self._handle("GET")

        def do_POST(self):
            self._handle("POST")

        def do_PUT(self):
            self._handle("PUT")

        def do_PATCH(self):
            self._handle("PATCH")

        def do_DELETE(self):
            self._handle("DELETE")

    return Handler


def create_server(store, port, calendar=None):
    """Crée le serveur (lève OSError si le port est pris). port=0 → port libre (tests)."""
    server_ref = {}
    server = ThreadingHTTPServer(("127.0.0.1", port), None)
    server.daemon_threads = True
    actual_port = server.server_address[1]
    server.RequestHandlerClass = make_handler(store, calendar or Calendar(), server_ref, actual_port)
    server_ref["server"] = server
    return server
