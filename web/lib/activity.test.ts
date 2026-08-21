import assert from "node:assert/strict";
import test from "node:test";

import { lastMatched, matchDisplay, matchRate, NO_RATE, type MatchEntry } from "./activity.ts";

const NOW = new Date("2026-08-20T12:00:00Z");
const DAY = 86_400_000;

/** A history of `count` matches on each of the `days` days ending today. */
function daily(days: number, count: number, endingDaysAgo = 0): MatchEntry {
  const matches: Record<string, number> = {};
  for (let i = 0; i < days; i += 1) {
    const at = new Date(NOW.getTime() - (i + endingDaysAgo) * DAY);
    matches[at.toISOString().slice(0, 10)] = count;
  }
  return { last_matched_at: null, daily_matches: matches };
}

/**
 * `total` matches over a history `span` days long ending today. The rate depends
 * on the total and the span, not on how the matches fall between them, so these
 * sit on the first and last day and pin the window exactly.
 */
function history(total: number, span: number): MatchEntry {
  const day = (daysAgo: number) =>
    new Date(NOW.getTime() - daysAgo * DAY).toISOString().slice(0, 10);
  if (span <= 1) return { last_matched_at: null, daily_matches: { [day(0)]: total } };
  return { last_matched_at: null, daily_matches: { [day(span - 1)]: 1, [day(0)]: total - 1 } };
}

// --- rate: the unit it picks ------------------------------------------------

test("a label with no history at all has no rate", () => {
  assert.equal(matchRate(undefined, NOW), NO_RATE);
  assert.equal(matchRate({ last_matched_at: null, daily_matches: {} }, NOW), NO_RATE);
});

test("about five a day reads as five a day", () => {
  assert.equal(matchRate(history(5 * 365, 365), NOW), "~5/day");
});

test("about six a week reads as six a week, not one a day", () => {
  // Both readings are single-digit; the coarser unit is the one that says
  // something, since rounding the daily rate would flatten it to one.
  assert.equal(matchRate(history(Math.round((6 / 7) * 365), 365), NOW), "~6/week");
});

test("about eight a month reads as eight a month", () => {
  assert.equal(matchRate(history(Math.round((8 / 30) * 365), 365), NOW), "~8/month");
});

test("about four a year reads as four a year", () => {
  assert.equal(matchRate(history(4, 365), NOW), "~4/year");
});

test("less than about once a year has no rate", () => {
  // A single match, well outside the one-year window.
  const at = new Date(NOW.getTime() - 500 * DAY);
  const entry: MatchEntry = {
    last_matched_at: at.toISOString(),
    daily_matches: { [at.toISOString().slice(0, 10)]: 1 },
  };
  assert.equal(matchRate(entry, NOW), NO_RATE);
});

test("more than nine a week is shown per day instead", () => {
  // Fourteen a week; the week reading would not be single-digit.
  assert.equal(matchRate(history(2 * 365, 365), NOW), "~2/day");
});

test("more than nine a month is shown per week instead", () => {
  // Twenty a month is about five a week.
  assert.equal(matchRate(history(Math.round((20 / 30) * 365), 365), NOW), "~5/week");
});

test("more than nine a year is shown per month instead", () => {
  assert.equal(matchRate(history(12, 365), NOW), "~1/month");
});

// --- rate: the window it measures over --------------------------------------

test("a label created days ago is rated over a week, not a year", () => {
  // Nine matches over three days. Rated over the year it has not lived through,
  // this would round to nothing.
  assert.equal(matchRate(daily(3, 3), NOW), "~9/week");
});

test("a single match on the day a label was created is not one a day", () => {
  // The week-long floor damps it. One a week is four a month, and the coarser
  // unit is the one that stays single-digit and readable.
  const today = NOW.toISOString().slice(0, 10);
  const entry: MatchEntry = { last_matched_at: null, daily_matches: { [today]: 1 } };
  assert.equal(matchRate(entry, NOW), "~4/month");
});

test("sparse history counts the quiet days in between", () => {
  // Two matches sixty days apart is not two a day.
  const entry: MatchEntry = { last_matched_at: null, daily_matches: {} };
  for (const daysAgo of [0, 60]) {
    const at = new Date(NOW.getTime() - daysAgo * DAY);
    entry.daily_matches[at.toISOString().slice(0, 10)] = 1;
  }
  assert.equal(matchRate(entry, NOW), "~1/month");
});

test("a label that stopped matching a year ago falls back to no rate", () => {
  assert.equal(matchRate(daily(30, 20, 400), NOW), NO_RATE);
});

test("days outside the window are not counted", () => {
  // Busy for a month, two years ago, and once yesterday.
  const entry = daily(30, 50, 700);
  const yesterday = new Date(NOW.getTime() - DAY).toISOString().slice(0, 10);
  entry.daily_matches[yesterday] = 1;
  assert.equal(matchRate(entry, NOW), "~1/year");
});

// --- last matched -----------------------------------------------------------

test("no last_matched_at reads as never matched", () => {
  assert.equal(lastMatched(undefined, NOW), "Never matched");
  assert.equal(lastMatched({ last_matched_at: null, daily_matches: {} }, NOW), "Never matched");
});

test("an unreadable timestamp reads as never matched rather than breaking", () => {
  assert.equal(
    lastMatched({ last_matched_at: "yesterday", daily_matches: {} }, NOW),
    "Never matched",
  );
});

/**
 * A moment `days` local calendar days before NOW. Built by local date arithmetic
 * rather than by subtracting milliseconds, so the day count these tests assert is
 * the same one the formatter sees, in any timezone.
 */
function daysAgoLocal(days: number, hour = 12): string {
  const at = new Date(NOW);
  at.setDate(at.getDate() - days);
  at.setHours(hour, 0, 0, 0);
  return at.toISOString();
}

test("last matched names the day rather than the hour", () => {
  const at = (iso: string) =>
    lastMatched({ last_matched_at: iso, daily_matches: {} }, NOW);
  assert.equal(at(daysAgoLocal(0, 8)), "Last matched today");
  assert.equal(at(daysAgoLocal(0, 0)), "Last matched today");
  assert.equal(at(daysAgoLocal(1, 23)), "Last matched yesterday");
  assert.equal(at(daysAgoLocal(3)), "Last matched 3d ago");
  assert.equal(at(daysAgoLocal(29)), "Last matched 29d ago");
  assert.equal(at(daysAgoLocal(30)), "Last matched 1mo ago");
  assert.equal(at(daysAgoLocal(60)), "Last matched 2mo ago");
  assert.equal(at(daysAgoLocal(365)), "Last matched 1y ago");
  assert.equal(at(daysAgoLocal(400)), "Last matched 1y ago");
});

test("a timestamp in the future reads as today rather than as negative", () => {
  const at = new Date(NOW.getTime() + 5 * 3_600_000).toISOString();
  assert.equal(lastMatched({ last_matched_at: at, daily_matches: {} }, NOW), "Last matched today");
});

// --- what a card is given ---------------------------------------------------

test("a matched label gives a rate to show beside the name", () => {
  const entry = history(Math.round((8 / 30) * 365), 365);
  entry.last_matched_at = daysAgoLocal(0, 9);
  assert.deepEqual(matchDisplay(entry, NOW), {
    rate: "~8/month",
    last: "Last matched today",
  });
});

test("a label that never matched gives no rate at all", () => {
  assert.deepEqual(matchDisplay(undefined, NOW), { rate: null, last: "Never matched" });
  assert.deepEqual(matchDisplay({ last_matched_at: null, daily_matches: {} }, NOW), {
    rate: null,
    last: "Never matched",
  });
});

test("a rate that has aged out is left off rather than shown as a dash", () => {
  // Matched once, long enough ago that the rate window no longer covers it.
  const at = new Date(NOW.getTime() - 500 * DAY);
  const entry: MatchEntry = {
    last_matched_at: daysAgoLocal(500),
    daily_matches: { [at.toISOString().slice(0, 10)]: 1 },
  };
  assert.equal(matchRate(entry, NOW), NO_RATE);
  assert.deepEqual(matchDisplay(entry, NOW), { rate: null, last: "Last matched 1y ago" });
});
