"""Stockage SQLite : schéma versionné, validation, corbeille, historique, sauvegardes."""
import logging
import re
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path

log = logging.getLogger(__name__)

KEEP_BACKUPS = 30
TRASH_DAYS = 30
DONE_VISIBLE_DAYS = 14
DEFAULT_PROJECTS = [("Perso", "#888780")]

# Chaque entrée fait passer la base de la version i-1 à la version i (PRAGMA user_version).
MIGRATIONS = {
    1: """
    CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, sort INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        quadrant INTEGER NOT NULL DEFAULT 2,
        due TEXT,
        estimate INTEGER NOT NULL DEFAULT 30,
        planned_date TEXT,
        planned_start TEXT,
        carried_from TEXT,
        reports INTEGER NOT NULL DEFAULT 0,
        done INTEGER NOT NULL DEFAULT 0,
        done_at TEXT,
        sort REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subtasks (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY,
        task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    """,
    2: """
    ALTER TABLE tasks ADD COLUMN updated_at TEXT;
    ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
    ALTER TABLE notes ADD COLUMN updated_at TEXT;
    ALTER TABLE notes ADD COLUMN deleted_at TEXT;
    UPDATE tasks SET updated_at = created_at;
    CREATE TABLE task_events (
        id INTEGER PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT
    );
    CREATE INDEX idx_tasks_planned ON tasks(planned_date);
    CREATE INDEX idx_notes_task ON notes(task_id);
    CREATE INDEX idx_subtasks_task ON subtasks(task_id);
    CREATE INDEX idx_events_task ON task_events(task_id);
    """,
}
SCHEMA_VERSION = max(MIGRATIONS)


class ValidationError(ValueError):
    pass


class NotFound(LookupError):
    pass


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------- validation

def _text(v, field, max_len, required=True):
    if v is None and not required:
        return None
    if not isinstance(v, str) or not v.strip():
        raise ValidationError(f"« {field} » ne peut pas être vide.")
    v = v.strip()
    if len(v) > max_len:
        raise ValidationError(f"« {field} » dépasse {max_len} caractères.")
    return v


def _date(v, field):
    if v in (None, ""):
        return None
    try:
        return date.fromisoformat(v).isoformat()
    except (TypeError, ValueError):
        raise ValidationError(f"Date invalide pour « {field} » : {v!r}.")


def _time(v, field):
    if v in (None, ""):
        return None
    if not isinstance(v, str) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", v):
        raise ValidationError(f"Heure invalide pour « {field} » : {v!r}.")
    return v


def _int(v, field, lo, hi, nullable=False):
    if v is None and nullable:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != int(v) or not lo <= v <= hi:
        raise ValidationError(f"« {field} » doit être un entier entre {lo} et {hi}.")
    return int(v)


def _num(v, field):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValidationError(f"« {field} » doit être un nombre.")
    return float(v)


def _color(v):
    if not isinstance(v, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", v):
        raise ValidationError(f"Couleur invalide : {v!r}.")
    return v


TASK_VALIDATORS = {
    "title": lambda v: _text(v, "titre", 500),
    "project_id": lambda v: _int(v, "projet", 1, 2**31, nullable=True),
    "quadrant": lambda v: _int(v, "quadrant", 1, 4),
    "due": lambda v: _date(v, "échéance"),
    "estimate": lambda v: _int(v, "durée", 5, 24 * 60),
    "planned_date": lambda v: _date(v, "date planifiée"),
    "planned_start": lambda v: _time(v, "heure planifiée"),
    "done": lambda v: _int(v, "terminée", 0, 1),
    "sort": lambda v: _num(v, "ordre"),
}


def clean(data, validators, partial):
    if not isinstance(data, dict):
        raise ValidationError("Requête invalide : objet JSON attendu.")
    unknown = set(data) - set(validators)
    if unknown:
        raise ValidationError(f"Champ(s) inconnu(s) : {', '.join(sorted(unknown))}.")
    out = {k: validators[k](v) for k, v in data.items()}
    if not partial and "title" in validators and "title" not in out:
        raise ValidationError("« titre » est obligatoire.")
    return out


# ---------------------------------------------------------------- stockage

class Store:
    def __init__(self, path, backup_dir=None, today=date.today):
        self.path = Path(path)
        self.backup_dir = Path(backup_dir) if backup_dir else self.path.parent / "backups"
        self.today = today  # injectable pour les tests
        self.lock = threading.RLock()
        is_new = not self.path.exists()
        self.con = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.con.row_factory = sqlite3.Row
        self.con.execute("PRAGMA foreign_keys = ON")
        self.con.execute("PRAGMA journal_mode = WAL")
        self.con.execute("PRAGMA synchronous = FULL")
        self.con.execute("PRAGMA busy_timeout = 5000")
        try:
            if not is_new:
                self._check_integrity()
            self._migrate(is_new)
            if not self.con.execute("SELECT 1 FROM projects LIMIT 1").fetchone():
                self.con.executemany("INSERT INTO projects(name, color) VALUES (?, ?)", DEFAULT_PROJECTS)
            self.purge_trash()
        except Exception:
            self.con.close()  # ne pas laisser le fichier verrouillé
            raise

    # -------- infrastructure

    def _check_integrity(self):
        result = self.con.execute("PRAGMA quick_check").fetchone()[0]
        if result != "ok":
            raise RuntimeError(
                f"La base {self.path.name} est endommagée ({result}). Restaure la dernière copie de "
                f"{self.backup_dir} en la renommant {self.path.name}.")

    def _migrate(self, is_new):
        version = self.con.execute("PRAGMA user_version").fetchone()[0]
        if version > SCHEMA_VERSION:
            raise RuntimeError(f"La base est en version {version}, plus récente que l'application "
                               f"(version {SCHEMA_VERSION}). Mets à jour l'application.")
        if version == SCHEMA_VERSION:
            return
        if not is_new:
            self.backup(suffix=f"avant-migration-v{SCHEMA_VERSION}")
        for v in range(version + 1, SCHEMA_VERSION + 1):
            with self.tx():
                for stmt in MIGRATIONS[v].split(";"):
                    if stmt.strip():
                        self.con.execute(stmt)
                self.con.execute(f"PRAGMA user_version = {v}")
            log.info("Base migrée en version %d", v)

    class _Tx:
        def __init__(self, store):
            self.store = store

        def __enter__(self):
            self.store.lock.acquire()
            self.store.con.execute("BEGIN IMMEDIATE")
            return self.store.con

        def __exit__(self, exc_type, *_):
            try:
                self.store.con.execute("ROLLBACK" if exc_type else "COMMIT")
            finally:
                self.store.lock.release()

    def tx(self):
        """Transaction : tout ou rien, protégée par le verrou."""
        return Store._Tx(self)

    def q(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.con.execute(sql, args).fetchall()]

    def close(self):
        with self.lock:
            self.con.close()

    def backup(self, force=False, suffix=None):
        """Copie cohérente (API backup de SQLite). Quotidienne par défaut ; 30 copies gardées."""
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = self.today().isoformat()
        if suffix:
            target = self.backup_dir / f"priorites-{stamp}-{suffix}.db"
        elif force:
            target = self.backup_dir / f"priorites-{stamp}-{datetime.now():%H%M%S}.db"
        else:
            target = self.backup_dir / f"priorites-{stamp}.db"
        if target.exists() and not force:
            return None
        with self.lock:
            dest = sqlite3.connect(target)
            try:
                self.con.backup(dest)
            finally:
                dest.close()
        for old in sorted(self.backup_dir.glob("priorites-*.db"))[:-KEEP_BACKUPS]:
            old.unlink()
        log.info("Sauvegarde : %s", target.name)
        return target.name

    def last_backup(self):
        files = sorted(self.backup_dir.glob("priorites-*.db"), key=lambda p: p.stat().st_mtime)
        if not files:
            return None
        return {"name": files[-1].name,
                "at": datetime.fromtimestamp(files[-1].stat().st_mtime).isoformat(timespec="seconds"),
                "count": len(files)}

    def _event(self, con, task_id, kind, detail=None):
        con.execute("INSERT INTO task_events(task_id, at, kind, detail) VALUES (?, ?, ?, ?)",
                    (task_id, now_iso(), kind, detail))

    def _task_row(self, con, task_id, include_deleted=False):
        row = con.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not row or (row["deleted_at"] and not include_deleted):
            raise NotFound(f"Tâche {task_id} introuvable.")
        return dict(row)

    def _check_project(self, con, project_id):
        if project_id is not None and not con.execute(
                "SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
            raise ValidationError(f"Projet {project_id} introuvable.")

    # -------- état global

    def carry_over(self):
        """Tâches planifiées un jour passé et non terminées → « Reportées », compteur +1."""
        today = self.today().isoformat()
        with self.tx() as con:
            late = con.execute(
                """SELECT id, planned_date FROM tasks WHERE done = 0 AND deleted_at IS NULL
                   AND planned_date IS NOT NULL AND planned_date < ?""", (today,)).fetchall()
            for r in late:
                con.execute(
                    """UPDATE tasks SET carried_from = planned_date, planned_date = NULL,
                       planned_start = NULL, reports = reports + 1, updated_at = ? WHERE id = ?""",
                    (now_iso(), r["id"]))
                self._event(con, r["id"], "reported", r["planned_date"])
        return len(late)

    def state(self):
        self.backup()
        self.carry_over()
        since = (self.today() - timedelta(days=DONE_VISIBLE_DAYS)).isoformat()
        with self.lock:
            tasks = self.q(
                """SELECT t.*, (SELECT COUNT(*) FROM notes n WHERE n.task_id = t.id
                                AND n.deleted_at IS NULL) AS note_count
                   FROM tasks t WHERE t.deleted_at IS NULL AND (t.done = 0 OR t.done_at >= ?)
                   ORDER BY t.sort, t.id""", (since,))
            subs = self.q("""SELECT s.* FROM subtasks s JOIN tasks t ON t.id = s.task_id
                             WHERE t.deleted_at IS NULL ORDER BY s.id""")
            by_task = {}
            for s in subs:
                by_task.setdefault(s["task_id"], []).append(s)
            for t in tasks:
                t["subtasks"] = by_task.get(t["id"], [])
            return {
                "today": self.today().isoformat(),
                "projects": self.q("SELECT * FROM projects ORDER BY sort, id"),
                "tasks": tasks,
                "settings": self.settings(),
                "trash_count": self.q("SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NOT NULL")[0]["n"],
            }

    # -------- projets

    def create_project(self, data):
        name = _text(data.get("name"), "nom", 80)
        color = _color(data.get("color", "#888780"))
        with self.tx() as con:
            return con.execute("INSERT INTO projects(name, color) VALUES (?, ?)", (name, color)).lastrowid

    def update_project(self, pid, data):
        fields = clean(data, {"name": lambda v: _text(v, "nom", 80), "color": _color,
                              "sort": lambda v: _int(v, "ordre", -10**9, 10**9)}, partial=True)
        with self.tx() as con:
            if not con.execute("SELECT 1 FROM projects WHERE id = ?", (pid,)).fetchone():
                raise NotFound(f"Projet {pid} introuvable.")
            for k, v in fields.items():
                con.execute(f"UPDATE projects SET {k} = ? WHERE id = ?", (v, pid))

    def delete_project(self, pid):
        with self.tx() as con:
            if not con.execute("DELETE FROM projects WHERE id = ?", (pid,)).rowcount:
                raise NotFound(f"Projet {pid} introuvable.")

    # -------- tâches

    def _check_not_past(self, planned_date, done):
        # Une tâche non faite planifiée dans le passé serait aussitôt « reportée » : on refuse.
        if planned_date and not done and planned_date < self.today().isoformat():
            raise ValidationError("Impossible de planifier une tâche non terminée dans le passé.")

    def create_task(self, data):
        fields = clean(data, TASK_VALIDATORS, partial=False)
        self._check_not_past(fields.get("planned_date"), fields.get("done"))
        fields.setdefault("sort", time.time())
        fields["created_at"] = fields["updated_at"] = now_iso()
        if fields.get("done"):
            fields["done_at"] = fields["created_at"]
        with self.tx() as con:
            self._check_project(con, fields.get("project_id"))
            cols = ", ".join(fields)
            tid = con.execute(f"INSERT INTO tasks({cols}) VALUES ({', '.join('?' * len(fields))})",
                              list(fields.values())).lastrowid
            self._event(con, tid, "created")
            if fields.get("planned_date"):
                self._event(con, tid, "planned", _plan_label(fields))
        return tid

    def update_task(self, tid, data):
        fields = clean(data, TASK_VALIDATORS, partial=True)
        with self.tx() as con:
            old = self._task_row(con, tid)
            if "project_id" in fields:
                self._check_project(con, fields["project_id"])
            if "done" in fields and fields["done"] != old["done"]:
                fields["done_at"] = now_iso() if fields["done"] else None
                self._event(con, tid, "done" if fields["done"] else "reopened")
            if fields.get("planned_date") and fields["planned_date"] != old["planned_date"]:
                self._check_not_past(fields["planned_date"], fields.get("done", old["done"]))
            if fields.get("planned_date"):
                fields["carried_from"] = None
            if fields.get("planned_start") and not fields.get("planned_date", old["planned_date"]):
                raise ValidationError("Une heure planifiée nécessite une date planifiée.")
            if "planned_date" in fields and fields["planned_date"] is None:
                fields["planned_start"] = None
            new_plan = (fields.get("planned_date", old["planned_date"]),
                        fields.get("planned_start", old["planned_start"]))
            if new_plan != (old["planned_date"], old["planned_start"]):
                if new_plan[0]:
                    self._event(con, tid, "planned", _plan_label(
                        {"planned_date": new_plan[0], "planned_start": new_plan[1]}))
                else:
                    self._event(con, tid, "unplanned")
            if "quadrant" in fields and fields["quadrant"] != old["quadrant"]:
                self._event(con, tid, "quadrant", f"{old['quadrant']}→{fields['quadrant']}")
            if "title" in fields and fields["title"] != old["title"]:
                self._event(con, tid, "renamed", old["title"])
            fields["updated_at"] = now_iso()
            for k, v in fields.items():
                con.execute(f"UPDATE tasks SET {k} = ? WHERE id = ?", (v, tid))

    def delete_task(self, tid):
        with self.tx() as con:
            self._task_row(con, tid)
            con.execute("UPDATE tasks SET deleted_at = ? WHERE id = ?", (now_iso(), tid))
            self._event(con, tid, "deleted")

    def restore_task(self, tid):
        with self.tx() as con:
            row = self._task_row(con, tid, include_deleted=True)
            if not row["deleted_at"]:
                return
            con.execute("UPDATE tasks SET deleted_at = NULL WHERE id = ?", (tid,))
            if row["project_id"] is not None and not con.execute(
                    "SELECT 1 FROM projects WHERE id = ?", (row["project_id"],)).fetchone():
                con.execute("UPDATE tasks SET project_id = NULL WHERE id = ?", (tid,))
            self._event(con, tid, "restored")

    def trash(self):
        return self.q("""SELECT t.*, (SELECT COUNT(*) FROM notes n WHERE n.task_id = t.id
                                     AND n.deleted_at IS NULL) AS note_count
                         FROM tasks t WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC""")

    def purge_task(self, tid):
        with self.tx() as con:
            row = self._task_row(con, tid, include_deleted=True)
            if not row["deleted_at"]:
                raise ValidationError("Seule une tâche dans la corbeille peut être supprimée définitivement.")
            con.execute("DELETE FROM tasks WHERE id = ?", (tid,))

    def purge_trash(self, days=TRASH_DAYS):
        limit = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
        with self.tx() as con:
            n = con.execute("DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?",
                            (limit,)).rowcount
            n += con.execute("DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?",
                             (limit,)).rowcount
        if n:
            log.info("Corbeille : %d élément(s) de plus de %d jours supprimé(s)", n, days)

    def events(self, tid):
        return self.q("SELECT * FROM task_events WHERE task_id = ? ORDER BY at DESC, id DESC", (tid,))

    # -------- sous-tâches

    def create_subtask(self, data):
        task_id = _int(data.get("task_id"), "tâche", 1, 2**31)
        title = _text(data.get("title"), "titre", 300)
        with self.tx() as con:
            self._task_row(con, task_id)
            return con.execute("INSERT INTO subtasks(task_id, title) VALUES (?, ?)",
                               (task_id, title)).lastrowid

    def update_subtask(self, sid, data):
        fields = clean(data, {"title": lambda v: _text(v, "titre", 300),
                              "done": lambda v: _int(v, "terminée", 0, 1)}, partial=True)
        with self.tx() as con:
            if not con.execute("SELECT 1 FROM subtasks WHERE id = ?", (sid,)).fetchone():
                raise NotFound(f"Sous-tâche {sid} introuvable.")
            for k, v in fields.items():
                con.execute(f"UPDATE subtasks SET {k} = ? WHERE id = ?", (v, sid))

    def delete_subtask(self, sid):
        with self.tx() as con:
            if not con.execute("DELETE FROM subtasks WHERE id = ?", (sid,)).rowcount:
                raise NotFound(f"Sous-tâche {sid} introuvable.")

    # -------- notes

    def notes(self, task_id=None):
        if task_id is not None:
            return self.q("""SELECT * FROM notes WHERE task_id = ? AND deleted_at IS NULL
                             ORDER BY created_at DESC, id DESC""", (task_id,))
        return self.q("""SELECT n.*, t.title AS task_title, t.project_id FROM notes n
                         LEFT JOIN tasks t ON t.id = n.task_id
                         WHERE n.deleted_at IS NULL AND (t.id IS NULL OR t.deleted_at IS NULL)
                         ORDER BY n.created_at DESC, n.id DESC""")

    def create_note(self, data):
        body = _text(data.get("body"), "note", 20000)
        task_id = _int(data.get("task_id"), "tâche", 1, 2**31, nullable=True)
        with self.tx() as con:
            if task_id is not None:
                self._task_row(con, task_id)
            return con.execute("INSERT INTO notes(task_id, body, created_at) VALUES (?, ?, ?)",
                               (task_id, body, now_iso())).lastrowid

    def _note_exists(self, con, nid, deleted=False):
        cond = "IS NOT NULL" if deleted else "IS NULL"
        if not con.execute(f"SELECT 1 FROM notes WHERE id = ? AND deleted_at {cond}", (nid,)).fetchone():
            raise NotFound(f"Note {nid} introuvable.")

    def update_note(self, nid, data):
        body = _text(data.get("body"), "note", 20000)
        with self.tx() as con:
            self._note_exists(con, nid)
            con.execute("UPDATE notes SET body = ?, updated_at = ? WHERE id = ?", (body, now_iso(), nid))

    def delete_note(self, nid):
        with self.tx() as con:
            self._note_exists(con, nid)
            con.execute("UPDATE notes SET deleted_at = ? WHERE id = ?", (now_iso(), nid))

    def restore_note(self, nid):
        with self.tx() as con:
            self._note_exists(con, nid, deleted=True)
            con.execute("UPDATE notes SET deleted_at = NULL WHERE id = ?", (nid,))

    # -------- paramètres et export

    SETTING_KEYS = {"ics_url": 2000, "day_start": 2, "day_end": 2}

    def settings(self):
        return {r["key"]: r["value"] for r in self.q("SELECT * FROM settings")}

    def update_settings(self, data):
        if not isinstance(data, dict):
            raise ValidationError("Requête invalide : objet JSON attendu.")
        for k, v in data.items():
            if k not in self.SETTING_KEYS:
                raise ValidationError(f"Paramètre inconnu : {k}.")
            if v is not None and (not isinstance(v, str) or len(v) > self.SETTING_KEYS[k]):
                raise ValidationError(f"Valeur invalide pour {k}.")
        if data.get("ics_url"):
            url = data["ics_url"].strip()
            if not re.match(r"^(https?|webcal)://", url, re.I):
                raise ValidationError("L'adresse de l'agenda doit commencer par https:// ou webcal://.")
            data["ics_url"] = url
        hours = {k: int(v) for k, v in data.items() if k in ("day_start", "day_end") and v}
        start = hours.get("day_start", int(self.settings().get("day_start", 7)))
        end = hours.get("day_end", int(self.settings().get("day_end", 21)))
        if not 0 <= start < end <= 24:
            raise ValidationError("Plage horaire invalide.")
        with self.tx() as con:
            for k, v in data.items():
                con.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (k, v))

    def export_all(self):
        tables = ["projects", "tasks", "subtasks", "notes", "task_events", "settings"]
        return {"exported_at": now_iso(), "schema_version": SCHEMA_VERSION,
                **{t: self.q(f"SELECT * FROM {t}") for t in tables}}


def _plan_label(f):
    return f["planned_date"] + (f" {f['planned_start']}" if f.get("planned_start") else "")
