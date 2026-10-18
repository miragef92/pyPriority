"""Lecture d'un agenda iCal (adresse secrète Google Agenda), en lecture seule."""
import logging
import re
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)

WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
TTL = 300
MAX_BYTES = 20 * 1024 * 1024


def _parse_dt(value, params):
    """Renvoie (datetime local naïf, journée_entière)."""
    value = value.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
        return datetime.strptime(value[:8], "%Y%m%d"), True
    if value.endswith("Z"):
        utc = datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        return utc.astimezone().replace(tzinfo=None), False
    naive = datetime.strptime(value[:15], "%Y%m%dT%H%M%S")
    tzid = params.get("TZID", "").strip('"')
    if tzid:
        try:
            from zoneinfo import ZoneInfo
            return naive.replace(tzinfo=ZoneInfo(tzid)).astimezone().replace(tzinfo=None), False
        except Exception:
            pass  # pas de base de fuseaux (Windows sans tzdata) : on suppose l'heure locale
    return naive, False


def _parse_line(line):
    head, _, value = line.partition(":")
    name, *raw_params = head.split(";")
    params = dict(p.split("=", 1) for p in raw_params if "=" in p)
    return name.upper(), params, value


def _unescape(s):
    return (s.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",")
             .replace("\\;", ";").replace("\\\\", "\\"))


def parse_ics(text):
    lines = []
    for raw in text.splitlines():
        if raw.startswith((" ", "\t")) and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    events, cur = [], None
    for line in lines:
        if line == "BEGIN:VEVENT":
            cur = {"exdates": set()}
        elif line == "END:VEVENT" and cur is not None:
            if "start" in cur:
                events.append(cur)
            cur = None
        elif cur is not None:
            try:
                name, params, value = _parse_line(line)
                if name == "SUMMARY":
                    cur["title"] = _unescape(value)
                elif name == "DTSTART":
                    cur["start"], cur["allday"] = _parse_dt(value, params)
                elif name == "DTEND":
                    cur["end"], _ = _parse_dt(value, params)
                elif name == "DURATION":
                    cur["duration"] = _parse_duration(value)
                elif name == "RRULE":
                    cur["rrule"] = dict(p.split("=", 1) for p in value.split(";") if "=" in p)
                elif name == "EXDATE":
                    for v in value.split(","):
                        cur["exdates"].add(_parse_dt(v, params)[0])
                elif name == "RECURRENCE-ID":
                    cur["recurrence_id"], _ = _parse_dt(value, params)
                elif name == "UID":
                    cur["uid"] = value
                elif name == "STATUS":
                    cur["status"] = value.upper()
            except (ValueError, KeyError) as e:
                log.warning("Ligne iCal ignorée (%s) : %s", e, line[:120])
    return events


def _parse_duration(v):
    m = re.fullmatch(r"P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", v.strip())
    if not m:
        raise ValueError(f"durée {v!r}")
    w, d, h, mi, s = (int(x or 0) for x in m.groups())
    return timedelta(weeks=w, days=d, hours=h, minutes=mi, seconds=s)


def _nth_weekday_ok(day, spec):
    """BYDAY du type 2TU (2e mardi) ou -1FR (dernier vendredi) pour FREQ=MONTHLY."""
    m = re.fullmatch(r"([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)", spec)
    if not m or WEEKDAYS[day.weekday()] != m.group(2):
        return False
    if not m.group(1):
        return True
    n = int(m.group(1))
    if n > 0:
        return (day.day - 1) // 7 + 1 == n
    days_in_month = ((day.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)).day
    return (days_in_month - day.day) // 7 + 1 == -n


def occurs_on(ev, day):
    """Datetime de début de l'occurrence le jour `day`, sinon None."""
    start = ev["start"]
    rule = ev.get("rrule")
    candidate = datetime.combine(day, start.time())
    if not rule:
        if ev.get("allday") and "end" in ev:  # congés sur plusieurs jours
            return candidate if start.date() <= day < max(ev["end"].date(), start.date() + timedelta(days=1)) else None
        return start if start.date() == day else None
    if day < start.date() or candidate in ev["exdates"]:
        return None
    until = rule.get("UNTIL")
    if until and day > _parse_dt(until, {})[0].date():
        return None
    freq, interval = rule.get("FREQ"), int(rule.get("INTERVAL", "1"))
    bydays = rule["BYDAY"].split(",") if "BYDAY" in rule else None
    if freq == "DAILY":
        delta = (day - start.date()).days
        ok = delta % interval == 0 and (not bydays or WEEKDAYS[day.weekday()] in bydays)
        n = delta // interval
    elif freq == "WEEKLY":
        bydays = bydays or [WEEKDAYS[start.weekday()]]
        week0 = start.date() - timedelta(days=start.weekday())
        weeks = (day - week0).days // 7
        ok = WEEKDAYS[day.weekday()] in bydays and weeks % interval == 0
        # nombre d'occurrences avant `day` (pour COUNT)
        n = (weeks // interval) * len(bydays) + sum(
            1 for d in bydays if WEEKDAYS.index(d) < day.weekday()) - sum(
            1 for d in bydays if WEEKDAYS.index(d) < start.weekday())
    elif freq == "MONTHLY":
        months = (day.year - start.year) * 12 + day.month - start.month
        if bydays:
            ok = months % interval == 0 and any(_nth_weekday_ok(day, d) for d in bydays)
        else:
            monthdays = [int(x) for x in rule.get("BYMONTHDAY", str(start.day)).split(",")]
            ok = months % interval == 0 and day.day in monthdays
        n = months // interval
    elif freq == "YEARLY":
        ok = (day.month, day.day) == (start.month, start.day) and (day.year - start.year) % interval == 0
        n = (day.year - start.year) // interval
    else:
        return None
    if ok and "COUNT" in rule and n >= int(rule["COUNT"]):
        return None
    return candidate if ok else None


def events_on(events, day):
    overridden = {(e.get("uid"), e["recurrence_id"]) for e in events if "recurrence_id" in e}
    out = []
    for ev in events:
        if ev.get("status") == "CANCELLED":
            continue
        try:
            occ = occurs_on(ev, day)
        except (ValueError, KeyError) as e:
            log.warning("Événement ignoré (%s) : %s", e, ev.get("title"))
            continue
        if occ is None or (ev.get("rrule") and (ev.get("uid"), occ) in overridden):
            continue
        if "end" in ev:
            duration = ev["end"] - ev["start"]
        else:
            duration = ev.get("duration", timedelta(hours=1))
        out.append({
            "title": ev.get("title", "(sans titre)"),
            "allday": ev.get("allday", False),
            "start": occ.strftime("%H:%M"),
            "minutes": max(15, min(24 * 60, int(duration.total_seconds() // 60))),
        })
    return sorted(out, key=lambda e: (not e["allday"], e["start"]))


class Calendar:
    """Télécharge l'agenda au plus toutes les 5 min ; garde la dernière version valide en cas d'erreur."""

    def __init__(self, fetch=None):
        self._fetch = fetch or self._http_get
        self._lock = threading.Lock()
        self.url = None
        self.events = []
        self.fetched_at = 0.0
        self.last_error = None

    @staticmethod
    def _http_get(url):
        url = re.sub(r"^webcal://", "https://", url, flags=re.I)
        req = urllib.request.Request(url, headers={"User-Agent": "pyPriority"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("agenda trop volumineux")
        return data.decode("utf-8", "replace")

    def invalidate(self):
        with self._lock:
            self.fetched_at = 0.0

    def for_day(self, url, day):
        """Renvoie (événements, avertissement ou None)."""
        if not url:
            return [], None
        with self._lock:
            if url != self.url:
                self.url, self.events, self.fetched_at = url, [], 0.0
            if time.time() - self.fetched_at > TTL:
                try:
                    text = self._fetch(url)
                    if "BEGIN:VCALENDAR" not in text:
                        raise ValueError("la réponse n'est pas un agenda iCal (adresse incorrecte ?)")
                    self.events = parse_ics(text)
                    self.last_error = None
                except Exception as e:
                    log.warning("Agenda indisponible : %s", e)
                    self.last_error = str(e)
                self.fetched_at = time.time() if self.last_error is None else time.time() - TTL + 60
            warning = None
            if self.last_error:
                warning = (f"Agenda non actualisé ({self.last_error}). Dernière version connue affichée."
                           if self.events else f"Agenda indisponible : {self.last_error}")
            return events_on(self.events, day), warning
