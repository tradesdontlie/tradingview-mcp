#!/usr/bin/env python3
"""Tests for the parts that would fail silently.

The point of these is not coverage — it is that every one of them fails loudly
if a specific bug this pipeline already had comes back. Run with:

    python3 tests/test_nowcast.py
"""
import datetime, os, sys, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "lib"))

import build
import derived
import history
import fmt
import indicators as I
import pillars as P
import universe as U
import verify
from sources import Obs


def series(ident, pairs, cadence="m"):
    return Obs(ident, [p[0] for p in pairs], [float(p[1]) for p in pairs],
               "test", 0.0, False)


class PeriodParsing(unittest.TestCase):
    def test_weekly_iso_week(self):
        self.assertEqual(I.parse_period("2026-W35"), datetime.date(2026, 8, 30))

    def test_month_label_dates_to_month_end(self):
        self.assertEqual(I.parse_period("2026-07"), datetime.date(2026, 7, 31))

    def test_fred_monthly_first_of_month_is_month_end(self):
        # FRED labels July CPI as 2026-07-01. Taking that literally ages every
        # monthly US series by 30 days and marks half the page stale.
        self.assertEqual(I.parse_period("2026-07-01", "m"), datetime.date(2026, 7, 31))

    def test_daily_series_keeps_its_actual_day(self):
        self.assertEqual(I.parse_period("2026-09-02", "d"), datetime.date(2026, 9, 2))

    def test_december_rolls_the_year(self):
        self.assertEqual(I.parse_period("2026-12", "m"), datetime.date(2026, 12, 31))


class Freshness(unittest.TestCase):
    spec = {"cadence": "w"}

    def test_within_cadence_is_verified(self):
        obs = series("x", [("2026-09-02", 1)])
        verdict, age, _ = I.freshness(obs, {"cadence": "w"}, today=datetime.date(2026, 9, 5))
        self.assertEqual(verdict, "verified")
        self.assertEqual(age, 3)

    def test_beyond_cadence_is_stale(self):
        obs = series("x", [("2026-08-01", 1)])
        verdict, _, _ = I.freshness(obs, {"cadence": "w"}, today=datetime.date(2026, 9, 5))
        self.assertEqual(verdict, "stale")

    def test_unchanged_period_is_carry_not_verified(self):
        obs = series("x", [("2026-09-02", 1)])
        verdict, _, _ = I.freshness(obs, {"cadence": "w"}, today=datetime.date(2026, 9, 5),
                                    previous_period="2026-09-02")
        self.assertEqual(verdict, "carry")

    def test_forward_dated_observation_is_not_negative_age(self):
        # FRED forward-dates IORB to the day the new rate takes effect.
        obs = series("x", [("2026-09-08", 1)])
        verdict, age, _ = I.freshness(obs, {"cadence": "d"}, today=datetime.date(2026, 9, 5))
        self.assertEqual(age, 0)
        self.assertEqual(verdict, "verified")


class Triad(unittest.TestCase):
    spec = {"cadence": "w", "scale": 1.0, "transform": "wow", "score_on": "wow"}

    def test_weekly_change_is_in_billions_from_millions(self):
        obs = series("res", [("2026-08-19", 2_975_000), ("2026-08-26", 2_924_936),
                             ("2026-09-02", 2_894_531)])
        c = I.compute(obs, self.spec)
        self.assertAlmostEqual(c["wow"], -30.405, places=3)
        self.assertAlmostEqual(c["level"], 2_894_531, places=0)

    def test_acceleration_is_the_change_in_velocity(self):
        obs = series("res", [("2026-08-19", 2_975_000), ("2026-08-26", 2_924_936),
                             ("2026-09-02", 2_894_531)])
        c = I.compute(obs, self.spec)
        # -30.405 this week against -50.064 last week
        self.assertAlmostEqual(c["accel_wow"], 19.659, places=3)

    def test_missing_history_yields_none_not_zero(self):
        c = I.compute(series("x", [("2026-09-02", 5)]), self.spec)
        self.assertIsNone(c["wow"])
        self.assertIsNone(c["accel_wow"])


class Scoring(unittest.TestCase):
    def test_polarity_flips_the_percentile(self):
        readings = {
            "a": {"score": 90.0, "scored": True, "weight": 1.0, "fresh": "verified"},
            "b": {"score": 10.0, "scored": True, "weight": 1.0, "fresh": "verified"},
        }
        score, coverage, _ = P.score_pillar(readings)
        self.assertAlmostEqual(score, 50.0)
        self.assertAlmostEqual(coverage, 1.0)

    def test_weights_are_honoured(self):
        readings = {
            "a": {"score": 100.0, "scored": True, "weight": 3.0, "fresh": "verified"},
            "b": {"score": 0.0, "scored": True, "weight": 1.0, "fresh": "verified"},
        }
        score, _, _ = P.score_pillar(readings)
        self.assertAlmostEqual(score, 75.0)

    def test_unscored_member_stays_out_of_the_arithmetic(self):
        readings = {
            "a": {"score": 100.0, "scored": True, "weight": 1.0, "fresh": "verified"},
            "oil": {"score": 0.0, "scored": False, "weight": 1.0, "fresh": "verified"},
        }
        score, _, _ = P.score_pillar(readings)
        self.assertAlmostEqual(score, 100.0)

    def test_unanimity_is_full_agreement(self):
        readings = {k: {"score": 60.0, "scored": True, "weight": 1.0, "fresh": "verified"}
                    for k in "abc"}
        _, _, agreement = P.score_pillar(readings)
        self.assertAlmostEqual(agreement, 1.0)

    def test_stale_member_lowers_coverage(self):
        readings = {
            "a": {"score": 50.0, "scored": True, "weight": 1.0, "fresh": "verified"},
            "b": {"score": 50.0, "scored": True, "weight": 1.0, "fresh": "stale"},
        }
        _, coverage, _ = P.score_pillar(readings)
        self.assertAlmostEqual(coverage, 0.5)


class RegistryHygiene(unittest.TestCase):
    def test_every_pillar_has_indicators(self):
        self.assertEqual(set(U.INDICATORS), {p[0] for p in U.PILLARS})
        for pid, specs in U.INDICATORS.items():
            self.assertTrue(specs, f"{pid} has no indicators")

    def test_weights_sum_to_one_hundred(self):
        self.assertEqual(sum(U.WEIGHTS.values()), 100)

    def test_no_daily_series_is_scored_on_its_daily_change(self):
        # The Fed target and IORB had 260 of 260 zero daily changes over a year;
        # percentile-ranking that is ranking a constant.
        offenders = [(pid, s["key"]) for pid, specs in U.INDICATORS.items() for s in specs
                     if s["cadence"] == "d" and s["score_on"] == "chg"]
        self.assertEqual(offenders, [])

    def test_every_spec_is_complete(self):
        required = {"key", "label", "provider", "ident", "cadence", "unit", "scale",
                    "transform", "score_on", "polarity", "weight", "scored", "source", "url"}
        for pid, specs in U.INDICATORS.items():
            for s in specs:
                self.assertTrue(required <= set(s), f"{pid}/{s.get('key')} missing "
                                                    f"{required - set(s)}")
                self.assertIn(s["polarity"], (1, -1))
                self.assertIn(s["cadence"], ("d", "w", "m"))

    def test_member_keys_are_unique_within_a_pillar(self):
        for pid, specs in U.INDICATORS.items():
            keys = [s["key"] for s in specs]
            self.assertEqual(len(keys), len(set(keys)), f"{pid} has duplicate keys")


class Derived(unittest.TestCase):
    def test_spread_of_two_daily_series(self):
        a = series("sofr", [("2026-09-01", 3.66), ("2026-09-02", 3.65), ("2026-09-03", 3.66)])
        b = series("iorb", [("2026-09-01", 3.65), ("2026-09-02", 3.65), ("2026-09-03", 3.65)])
        d = derived.combine("s", [a, b], lambda x, y: (x - y) * 100)
        self.assertEqual(len(d), 3)
        self.assertAlmostEqual(d.last, 1.0, places=6)

    def test_mixed_frequency_uses_last_value_on_or_before(self):
        weekly = series("w", [("2026-09-02", 100.0)])
        daily = series("d", [("2026-08-30", 7.0), ("2026-09-01", 9.0), ("2026-09-04", 11.0)])
        d = derived.combine("x", [weekly, daily], lambda w, dd: w - dd)
        # 2026-09-04 is after the weekly date, so 2026-09-01's value is used.
        self.assertAlmostEqual(d.last, 91.0)

    def test_a_missing_part_yields_no_series_rather_than_a_wrong_one(self):
        self.assertIsNone(derived.combine("x", [series("a", [("2026-09-01", 1)]), None],
                                          lambda a, b: a - b))

    def test_period_before_the_other_series_starts_is_dropped(self):
        base = series("w", [("2026-01-01", 1.0), ("2026-09-02", 2.0)])
        late = series("d", [("2026-06-01", 5.0)])
        d = derived.combine("x", [base, late], lambda a, b: a + b)
        self.assertEqual(d.periods, ["2026-09-02"])


class Formatting(unittest.TestCase):
    def test_trillion_stock_keeps_the_weekly_move_visible(self):
        # At one decimal a $30bn move inside $2.9tn rounds away entirely.
        self.assertEqual(fmt.usd(2_894_531), "$2.895tn")

    def test_billions_and_millions(self):
        self.assertEqual(fmt.usd(967_935), "$967.9bn")
        self.assertEqual(fmt.usd(132), "$132mn")

    def test_signed_values_use_a_real_minus(self):
        self.assertTrue(fmt.signed_usd_bn(-30.405).startswith("−"))
        self.assertTrue(fmt.signed_usd_bn(30.405).startswith("+"))

    def test_none_never_renders_as_a_number(self):
        for fn in (fmt.usd, fmt.eur, fmt.pct, fmt.num, fmt.thousands, fmt.usd_bn):
            self.assertEqual(fn(None), "n/a")

    def test_period_labels_are_written_out(self):
        self.assertEqual(fmt.period("2026-07"), "July 2026")
        self.assertEqual(fmt.period("2026-W35"), "week 35 2026")


class PageGate(unittest.TestCase):
    # The size floor is a separate check; pad past it so each test exercises
    # only the rule it names.
    HEAD = "<!doctype html><meta charset=utf-8>"
    PAD = "<p>ordinary page content</p>" * 900

    def page(self, extra=""):
        return self.HEAD + self.PAD + extra

    def test_placeholder_inside_a_word_is_not_a_defect(self):
        self.assertEqual(verify.check_page(self.page("<p>PBoC aggregate financing</p>")), [])

    def test_javascript_undefined_is_not_a_defect(self):
        self.assertEqual(verify.check_page(self.page("<script>if(d===undefined){}</script>")), [])

    def test_nan_literal_in_script_is_not_a_defect(self):
        self.assertEqual(verify.check_page(self.page("<script>if(isNaN(x)){}</script>")), [])

    def test_placeholder_in_visible_text_is_caught(self):
        self.assertTrue(any("TODO" in e for e in verify.check_page(self.page("<p>TODO</p>"))))

    def test_external_asset_breaks_self_containment(self):
        page = self.page('<script src="https://cdn/x.js"></script>')
        self.assertTrue(any("self-contained" in e for e in verify.check_page(page)))

    def test_runtime_fetch_breaks_self_containment(self):
        page = self.page("<script>fetch('/api')</script>")
        self.assertTrue(any("self-contained" in e for e in verify.check_page(page)))

    def test_a_page_too_small_to_hold_the_content_is_caught(self):
        self.assertTrue(any("bytes" in e for e in verify.check_page(self.HEAD + "<p>x</p>")))


class VintageGate(unittest.TestCase):
    def _vintage(self, **over):
        base = {"score": 50.0, "freshness": "verified", "direction": "mixed",
                "confidence": "high", "triad": ["a 1", "b 2", "c 3"], "facts": [["1", "x"]],
                "status": "OK", "copy": "text", "members": 2, "gaps": [], "readings": {},
                "age_days": 1}
        cards = [dict(base, id=pillar[0]) for pillar in U.PILLARS]
        v = {"cards": cards,
             "composite": {"score": 44, "raw": 44.0, "weight_covered": 100.0},
             "regime": {"title": "t"}, "timeline": [{"date": "2026-09-02"}]}
        v.update(over)
        return v

    def test_a_healthy_vintage_passes(self):
        self.assertEqual(verify.check_vintage(self._vintage()), [])

    def test_all_na_triad_is_caught(self):
        v = self._vintage()
        v["cards"][0]["triad"] = ["n/a", "n/a", "n/a"]
        self.assertTrue(any("n/a" in e for e in verify.check_vintage(v)))

    def test_score_outside_range_is_caught(self):
        v = self._vintage()
        v["cards"][0]["score"] = 140.0
        self.assertTrue(any("outside 0-100" in e for e in verify.check_vintage(v)))

    def test_missing_pillar_is_caught(self):
        v = self._vintage()
        v["cards"] = v["cards"][:-1]
        self.assertTrue(verify.check_vintage(v))

    def test_thin_coverage_is_caught(self):
        v = self._vintage()
        v["composite"]["weight_covered"] = 20.0
        self.assertTrue(any("weight" in e for e in verify.check_vintage(v)))

    def test_mostly_stale_page_is_caught(self):
        v = self._vintage()
        for c in v["cards"]:
            c["freshness"] = "stale"
        self.assertTrue(any("current" in e for e in verify.check_vintage(v)))


class Ledger(unittest.TestCase):
    def test_first_run_states_it_is_a_baseline(self):
        rows = build.build_ledger([], None)
        self.assertIn("Baseline", rows[0]["input"])

    def test_an_advanced_observation_is_reported(self):
        cards = [{"id": "US-LIQ", "title": "Treasury / Fed liquidity", "score": 50.0,
                  "periods": {"reserves": "2026-09-02"},
                  "readings": {"reserves": {"label": "Reserve balances", "level": 2_894_531,
                                            "unit": "usd_mn", "period": "2026-09-02"}}}]
        prev = {"cards": [{"id": "US-LIQ", "title": "Treasury / Fed liquidity", "score": 55.0,
                           "periods": {"reserves": "2026-08-26"}, "readings": {}}]}
        rows = build.build_ledger(cards, prev)
        self.assertEqual(len(rows), 1)
        self.assertIn("Reserve balances", rows[0]["input"])
        self.assertIn("2 Sep 2026", rows[0]["change"])
        self.assertIn("55.0", rows[0]["consequence"])

    def test_no_movement_is_reported_as_no_movement(self):
        cards = [{"id": "US-LIQ", "title": "T", "score": 50.0,
                  "periods": {"reserves": "2026-09-02"}, "readings": {}}]
        prev = {"cards": [{"id": "US-LIQ", "title": "T", "score": 50.0,
                           "periods": {"reserves": "2026-09-02"}, "readings": {}}]}
        rows = build.build_ledger(cards, prev)
        self.assertIn("No change", rows[0]["input"])


class Composite(unittest.TestCase):
    def _cards(self, scores):
        return [{"id": pillar[0], "score": scores.get(pillar[0]),
                 "weight": U.WEIGHTS.get(pillar[0], 0), "confidence_value": 80.0,
                 "title": pillar[0]} for pillar in U.PILLARS]

    def test_a_dropped_pillar_renormalises_rather_than_scoring_zero(self):
        scores = {pid: 60.0 for pid in U.WEIGHTS}
        scores["JP-LIQ"] = None
        comp = build.build_composite(self._cards(scores), None)
        # Every surviving pillar is 60, so the composite must be 60 — not 54,
        # which is what treating the gap as a zero would produce.
        self.assertAlmostEqual(comp["raw"], 60.0, places=6)
        self.assertLess(comp["weight_covered"], 100.0)

    def test_full_coverage_is_a_weighted_mean(self):
        scores = {pid: 40.0 for pid in U.WEIGHTS}
        scores["US-LIQ"] = 100.0
        comp = build.build_composite(self._cards(scores), None)
        expected = (40 * (100 - 30) + 100 * 30) / 100
        self.assertAlmostEqual(comp["raw"], expected, places=6)
        self.assertEqual(comp["weight_covered"], 100.0)

    def test_unweighted_pillars_never_enter_the_score(self):
        scores = {pid: 50.0 for pid in U.WEIGHTS}
        cards = self._cards(scores)
        for c in cards:
            if not c["weight"]:
                c["score"] = 0.0
        comp = build.build_composite(cards, None)
        self.assertAlmostEqual(comp["raw"], 50.0, places=6)


class BakeLock(unittest.TestCase):
    def test_a_second_bake_is_refused_while_one_holds_the_lock(self):
        with history.lock():
            with self.assertRaises(history.Locked):
                with history.lock():
                    pass

    def test_the_lock_is_released_on_exit(self):
        with history.lock():
            self.assertTrue(os.path.exists(history.LOCK))
        self.assertFalse(os.path.exists(history.LOCK))

    def test_the_lock_is_released_even_when_the_bake_raises(self):
        with self.assertRaises(ValueError):
            with history.lock():
                raise ValueError("bake blew up")
        self.assertFalse(os.path.exists(history.LOCK))


if __name__ == "__main__":
    unittest.main(verbosity=2)
