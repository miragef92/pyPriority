import unittest
from datetime import date

from priority.ical import Calendar, events_on, parse_ics

ICS = """BEGIN:VCALENDAR
BEGIN:VEVENT
UID:hebdo
DTSTART;TZID=Europe/Paris:20261005T110000
DTEND;TZID=Europe/Paris:20261005T120000
RRULE:FREQ=WEEKLY;BYDAY=MO,FR
EXDATE;TZID=Europe/Paris:20261016T110000
SUMMARY:Réunion équipe\\, propu
END:VEVENT
BEGIN:VEVENT
UID:hebdo
RECURRENCE-ID;TZID=Europe/Paris:20261012T110000
DTSTART;TZID=Europe/Paris:20261012T140000
DTEND;TZID=Europe/Paris:20261012T150000
SUMMARY:Réunion équipe (décalée)
END:VEVENT
BEGIN:VEVENT
UID:conges
DTSTART;VALUE=DATE:20261019
DTEND;VALUE=DATE:20261024
SUMMARY:Congés
END:VEVENT
BEGIN:VEVENT
UID:mensuel
DTSTART:20261013T090000
DURATION:PT30M
RRULE:FREQ=MONTHLY;BYDAY=2TU
SUMMARY:Revue mensuelle
END:VEVENT
BEGIN:VEVENT
UID:dernier
DTSTART:20261030T160000
DTEND:20261030T170000
RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=2
SUMMARY:Bilan
END:VEVENT
BEGIN:VEVENT
UID:count
DTSTART:20261005T080000
DTEND:20261005T081500
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Daily
END:VEVENT
BEGIN:VEVENT
UID:annule
DTSTART:20261009T100000
STATUS:CANCELLED
SUMMARY:Annulé
END:VEVENT
BEGIN:VEVENT
UID:casse
DTSTART:pas-une-date
SUMMARY:Cassé
END:VEVENT
END:VCALENDAR"""


def titles(day):
    return [(e["title"], e["start"]) for e in events_on(parse_ics(ICS), day)]


class IcalTest(unittest.TestCase):
    def test_weekly_with_exdate_and_override(self):
        self.assertEqual(titles(date(2026, 10, 9)), [("Réunion équipe, propu", "11:00")])
        self.assertEqual(titles(date(2026, 10, 12)), [("Réunion équipe (décalée)", "14:00")])
        self.assertEqual(titles(date(2026, 10, 16)), [])  # EXDATE
        self.assertNotIn("Réunion équipe, propu", [t for t, _ in titles(date(2026, 10, 7))])  # mercredi

    def test_multi_day_all_day(self):
        for d in (19, 23):
            self.assertIn(("Congés", "00:00"), titles(date(2026, 10, d)))
        self.assertNotIn(("Congés", "00:00"), titles(date(2026, 10, 24)))

    def test_monthly_nth_weekday_and_duration(self):
        ev = [e for e in events_on(parse_ics(ICS), date(2026, 11, 10)) if e["title"] == "Revue mensuelle"]
        self.assertEqual(ev[0]["minutes"], 30)
        self.assertEqual(titles(date(2026, 11, 3)), [])

    def test_last_weekday_with_count(self):
        self.assertIn(("Bilan", "16:00"), titles(date(2026, 11, 27)))
        self.assertNotIn(("Bilan", "16:00"), titles(date(2026, 12, 25)))  # COUNT=2 épuisé

    def test_daily_count(self):
        self.assertIn(("Daily", "08:00"), titles(date(2026, 10, 7)))
        self.assertNotIn(("Daily", "08:00"), titles(date(2026, 10, 8)))

    def test_cancelled_and_broken_events_ignored(self):
        self.assertNotIn("Annulé", [t for t, _ in titles(date(2026, 10, 9))])


class CalendarTest(unittest.TestCase):
    def test_keeps_last_good_version_on_error(self):
        calls = {"n": 0}

        def fetch(url):
            calls["n"] += 1
            if calls["n"] > 1:
                raise OSError("réseau coupé")
            return ICS

        cal = Calendar(fetch=fetch)
        events, warning = cal.for_day("https://x", date(2026, 10, 9))
        self.assertEqual((len(events), warning), (1, None))
        cal.invalidate()
        events, warning = cal.for_day("https://x", date(2026, 10, 9))
        self.assertEqual(len(events), 1)
        self.assertIn("Dernière version connue", warning)

    def test_not_ical(self):
        cal = Calendar(fetch=lambda url: "<html>login</html>")
        events, warning = cal.for_day("https://x", date(2026, 10, 9))
        self.assertEqual(events, [])
        self.assertIn("pas un agenda", warning)

    def test_no_url(self):
        self.assertEqual(Calendar(fetch=None).for_day(None, date(2026, 10, 9)), ([], None))


if __name__ == "__main__":
    unittest.main()
