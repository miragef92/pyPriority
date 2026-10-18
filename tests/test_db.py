import sqlite3
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from priority import db
from priority.db import NotFound, Store, ValidationError


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.day = date(2026, 10, 9)
        self.store = Store(self.dir / "t.db", today=lambda: self.day)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def task(self, **kw):
        return self.store.create_task({"title": "T", **kw})

    def get(self, tid):
        return self.store.q("SELECT * FROM tasks WHERE id = ?", (tid,))[0]

    # -------- schéma

    def test_fresh_db_is_at_latest_version(self):
        v = self.store.con.execute("PRAGMA user_version").fetchone()[0]
        self.assertEqual(v, db.SCHEMA_VERSION)
        self.assertEqual(self.store.state()["projects"][0]["name"], "Perso")

    def test_migrates_v1_database_and_keeps_data(self):
        path = self.dir / "old.db"
        con = sqlite3.connect(path)
        con.executescript(db.MIGRATIONS[1])
        con.execute("INSERT INTO projects(name, color) VALUES ('Propu', '#7F77DD')")
        con.execute("INSERT INTO tasks(title, created_at) VALUES ('Ancienne', '2026-10-01T10:00:00')")
        con.commit()
        con.close()
        s = Store(path, today=lambda: self.day)
        try:
            tasks = s.state()["tasks"]
            self.assertEqual([t["title"] for t in tasks], ["Ancienne"])
            self.assertEqual(tasks[0]["updated_at"], "2026-10-01T10:00:00")
            self.assertTrue(list((self.dir / "backups").glob("*avant-migration*")))
        finally:
            s.close()

    def test_refuses_newer_schema(self):
        self.store.con.execute("PRAGMA user_version = 999")
        self.store.close()
        with self.assertRaises(RuntimeError):
            Store(self.dir / "t.db")
        self.store = Store(self.dir / "other.db")

    # -------- validation

    def test_validation(self):
        bad = [{"title": ""}, {"title": "x", "quadrant": 5}, {"title": "x", "due": "2026-13-01"},
               {"title": "x", "planned_date": "2026-10-09", "planned_start": "25:00"},
               {"title": "x", "estimate": 0}, {"title": "x", "estimate": "30"},
               {"title": "x", "hack": 1}, {"title": "x", "project_id": 999}, {"quadrant": 1}]
        for data in bad:
            with self.subTest(data=data), self.assertRaises(ValidationError):
                self.store.create_task(data)

    def test_time_without_date_rejected(self):
        tid = self.task()
        with self.assertRaises(ValidationError):
            self.store.update_task(tid, {"planned_start": "10:00"})

    def test_unknown_ids(self):
        with self.assertRaises(NotFound):
            self.store.update_task(42, {"title": "x"})
        with self.assertRaises(NotFound):
            self.store.create_note({"task_id": 42, "body": "x"})

    def test_failed_update_is_rolled_back(self):
        tid = self.task(quadrant=1)
        with self.assertRaises(ValidationError):
            self.store.update_task(tid, {"quadrant": 3, "planned_start": "10:00"})
        self.assertEqual(self.get(tid)["quadrant"], 1)

    # -------- logique métier

    def test_carry_over(self):
        tid = self.task(planned_date="2026-10-09")
        done = self.task(planned_date="2026-10-08", done=1)
        self.day = date(2026, 10, 10)  # le lendemain, la tâche non faite est reportée
        today = self.task(planned_date="2026-10-10")
        self.store.state()
        t = self.get(tid)
        self.assertEqual((t["planned_date"], t["carried_from"], t["reports"]), (None, "2026-10-09", 1))
        self.assertEqual(self.get(done)["planned_date"], "2026-10-08")
        self.assertEqual(self.get(today)["reports"], 0)
        self.store.state()  # idempotent
        self.assertEqual(self.get(tid)["reports"], 1)
        self.assertEqual(self.store.events(tid)[0]["kind"], "reported")
        # replanifier efface « Reportées », garde le compteur
        self.store.update_task(tid, {"planned_date": "2026-10-10"})
        t = self.get(tid)
        self.assertEqual((t["carried_from"], t["reports"]), (None, 1))

    def test_cannot_plan_in_the_past(self):
        with self.assertRaises(ValidationError):
            self.task(planned_date="2026-10-08")
        tid = self.task()
        with self.assertRaises(ValidationError):
            self.store.update_task(tid, {"planned_date": "2026-10-08", "planned_start": "10:00"})
        self.task(planned_date="2026-10-08", done=1)  # une tâche faite peut être datée du passé
        self.store.update_task(tid, {"planned_date": "2026-10-09"})

    def test_unplan_clears_time(self):
        tid = self.task(planned_date="2026-10-09", planned_start="09:00")
        self.store.update_task(tid, {"planned_date": None})
        self.assertIsNone(self.get(tid)["planned_start"])

    def test_done_sets_timestamp_and_history(self):
        tid = self.task()
        self.store.update_task(tid, {"done": 1})
        self.assertIsNotNone(self.get(tid)["done_at"])
        self.store.update_task(tid, {"done": 0})
        self.assertIsNone(self.get(tid)["done_at"])
        kinds = [e["kind"] for e in self.store.events(tid)]
        self.assertEqual(kinds, ["reopened", "done", "created"])

    def test_old_done_tasks_hidden(self):
        tid = self.task()
        self.store.update_task(tid, {"done": 1})
        self.store.con.execute("UPDATE tasks SET done_at = '2026-01-01T00:00:00' WHERE id = ?", (tid,))
        self.assertEqual(self.store.state()["tasks"], [])

    def test_trash_restore_and_purge(self):
        tid = self.task()
        self.store.create_note({"task_id": tid, "body": "n"})
        self.store.delete_task(tid)
        state = self.store.state()
        self.assertEqual((state["tasks"], state["trash_count"]), ([], 1))
        self.assertEqual(self.store.notes(), [])
        self.store.restore_task(tid)
        self.assertEqual(len(self.store.state()["tasks"]), 1)
        with self.assertRaises(ValidationError):
            self.store.purge_task(tid)
        self.store.delete_task(tid)
        self.store.purge_task(tid)
        self.assertEqual(self.store.q("SELECT * FROM notes"), [])

    def test_trash_auto_purge(self):
        tid = self.task()
        self.store.delete_task(tid)
        old = (date.today() - timedelta(days=40)).isoformat()
        self.store.con.execute("UPDATE tasks SET deleted_at = ? WHERE id = ?", (old, tid))
        self.store.purge_trash()
        self.assertEqual(self.store.trash(), [])

    def test_restore_after_project_deleted(self):
        pid = self.store.create_project({"name": "P", "color": "#7F77DD"})
        tid = self.task(project_id=pid)
        self.store.delete_task(tid)
        self.store.delete_project(pid)
        self.store.restore_task(tid)
        self.assertIsNone(self.get(tid)["project_id"])

    def test_notes_edit_delete_restore(self):
        nid = self.store.create_note({"body": "libre"})
        self.store.update_note(nid, {"body": "modifiée"})
        n = self.store.notes()[0]
        self.assertEqual(n["body"], "modifiée")
        self.assertIsNotNone(n["updated_at"])
        self.store.delete_note(nid)
        self.assertEqual(self.store.notes(), [])
        self.store.restore_note(nid)
        self.assertEqual(len(self.store.notes()), 1)

    def test_settings_validation(self):
        with self.assertRaises(ValidationError):
            self.store.update_settings({"ics_url": "file:///etc/passwd"})
        with self.assertRaises(ValidationError):
            self.store.update_settings({"day_start": "20", "day_end": "8"})
        with self.assertRaises(ValidationError):
            self.store.update_settings({"autre": "x"})
        self.store.update_settings({"ics_url": "webcal://exemple.com/a.ics"})
        self.assertEqual(self.store.settings()["ics_url"], "webcal://exemple.com/a.ics")

    # -------- sauvegardes

    def test_backup_daily_and_rotation(self):
        self.store.state()
        self.assertTrue((self.dir / "backups" / "priorites-2026-10-09.db").exists())
        self.assertIsNone(self.store.backup())  # déjà faite aujourd'hui
        for i in range(db.KEEP_BACKUPS + 5):
            (self.dir / "backups" / f"priorites-2020-01-{i:02d}.db").write_bytes(b"")
        self.store.backup(force=True)
        self.assertEqual(len(list((self.dir / "backups").glob("priorites-*.db"))), db.KEEP_BACKUPS)

    def test_backup_is_valid_copy(self):
        self.task(title="sauvée")
        name = self.store.backup(force=True)
        con = sqlite3.connect(self.dir / "backups" / name)
        self.assertEqual(con.execute("SELECT title FROM tasks").fetchone()[0], "sauvée")
        con.close()

    def test_export(self):
        self.task()
        data = self.store.export_all()
        self.assertEqual(len(data["tasks"]), 1)
        self.assertEqual(data["schema_version"], db.SCHEMA_VERSION)


if __name__ == "__main__":
    unittest.main()
