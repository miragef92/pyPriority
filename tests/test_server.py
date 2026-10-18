import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

from priority.db import Store
from priority.ical import Calendar
from priority.server import create_server


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "t.db")
        self.server = create_server(self.store, 0, Calendar(fetch=lambda url: "BEGIN:VCALENDAR\nEND:VCALENDAR"))
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.store.close()
        self.tmp.cleanup()

    def call(self, method, path, body=None, headers=None):
        h = {"Content-Type": "application/json", **(headers or {})}
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def json(self, method, path, body=None, **kw):
        code, raw = self.call(method, path, body, **kw)
        return code, json.loads(raw)

    def test_static_files(self):
        for path in ("/", "/app.js", "/style.css"):
            code, raw = self.call("GET", path)
            self.assertEqual(code, 200, path)
        self.assertEqual(self.call("GET", "/../app.py")[0], 404)

    def test_crud_flow(self):
        code, r = self.json("POST", "/api/tasks", {"title": "Relire", "quadrant": 1})
        self.assertEqual(code, 200)
        tid = r["id"]
        self.assertEqual(self.json("PATCH", f"/api/tasks/{tid}", {"done": 1})[0], 200)
        self.assertEqual(self.json("POST", "/api/notes", {"task_id": tid, "body": "note"})[0], 200)
        state = self.json("GET", "/api/state")[1]
        self.assertEqual(state["tasks"][0]["note_count"], 1)
        self.assertEqual(self.json("DELETE", f"/api/tasks/{tid}")[0], 200)
        self.assertEqual(self.json("POST", f"/api/tasks/{tid}/restore", {})[0], 200)
        events = self.json("GET", f"/api/tasks/{tid}/events")[1]
        self.assertEqual(events[0]["kind"], "restored")

    def test_errors_are_json(self):
        code, r = self.json("POST", "/api/tasks", {"title": ""})
        self.assertEqual(code, 400)
        self.assertIn("vide", r["error"])
        self.assertEqual(self.json("PATCH", "/api/tasks/999", {"title": "x"})[0], 404)
        self.assertEqual(self.json("GET", "/api/nimporte")[0], 404)
        code, raw = self.call("POST", "/api/tasks", None)
        self.assertEqual(code, 400)

    def test_invalid_json(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/tasks", data=b"{oops",
                                     method="POST", headers={"Content-Type": "application/json"})
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 400)

    def test_blocks_other_websites(self):
        code, _ = self.json("POST", "/api/tasks", {"title": "x"}, headers={"Origin": "https://malveillant.com"})
        self.assertEqual(code, 403)
        code, _ = self.call("POST", "/api/tasks", None, headers={"Content-Type": "text/plain"})
        self.assertEqual(code, 403)
        code, _ = self.json("GET", "/api/state", headers={"Host": "evil.com"})
        self.assertEqual(code, 403)
        self.assertEqual(self.store.state()["tasks"], [])

    def test_calendar_endpoint(self):
        self.assertEqual(self.json("GET", "/api/calendar?date=2026-10-09")[1],
                         {"days": [{"date": "2026-10-09", "events": []}], "warning": None})
        r = self.json("GET", "/api/calendar?date=2026-10-30&days=3")[1]
        self.assertEqual([d["date"] for d in r["days"]], ["2026-10-30", "2026-10-31", "2026-11-01"])
        self.assertEqual(self.json("GET", "/api/calendar?date=n")[0], 400)
        self.assertEqual(self.json("GET", "/api/calendar?date=2026-10-09&days=0")[0], 400)
        self.assertEqual(self.json("GET", "/api/calendar?date=2026-10-09&days=x")[0], 400)

    def test_ping(self):
        self.assertEqual(self.json("GET", "/api/ping")[1]["app"], "pypriority")


if __name__ == "__main__":
    unittest.main()
