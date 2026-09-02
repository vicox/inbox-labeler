/**
 * How often a label matches, and when it last did.
 *
 * Nothing here writes, and a label with no history is a normal state rather than a
 * gap to fill in. The store keeps a label, a day and a count — there is nothing
 * about an email to show even if this wanted to. The shape matches
 * `lib/inbox/matches.ts` field for field.
 *
 * `matchesPerDay` is the product's one answer to "how often does this label fire":
 * the signed-in page orders labels by it, and `lib/inbox/overview.ts` breaks a tie
 * between two matched labels with it. A second frequency model would let the same
 * two labels be rare in one place and busy in the other.
 */

export type MatchEntry = {
  last_matched_at: string | null;
  daily_matches: Record<string, number>;
};

/** Label text to its history. A label that has never matched is simply absent. */
export type Matches = Record<string, MatchEntry>;

const DAY = 24 * 60 * 60 * 1000;

/** Shown when a label matches less than about once a year, or never has. */
export const NO_RATE = "—";

/**
 * The window a rate is measured over: a year back, or the label's own history
 * when it is younger than that, and never shorter than a week.
 *
 * A year, because a label that fires four times a year has to be able to say so —
 * a shorter window would round every rare label down to nothing. The label's own
 * age, because one created on Tuesday should not read as rare for want of a year
 * of history. A week as the floor, because a single match on the day a label was
 * created is not evidence of one match per day.
 */
const WINDOW_DAYS = 365;
const MIN_WINDOW_DAYS = 7;

/**
 * Units from the coarsest down. A rate is shown in the largest unit that keeps
 * the number to a single digit, so fourteen a week is read back as two a day and
 * twenty a month as five a week: a small number in a familiar unit rather than a
 * big one in a coarse one.
 *
 * Abbreviated to a letter because a rate sits at the end of a label's name line,
 * where the room is whatever the name leaves. `days` is what picks the unit and is
 * not the abbreviation: changing a suffix changes what is read, never when.
 */
const UNITS = [
  { suffix: "y", days: 365 },
  { suffix: "m", days: 30 },
  { suffix: "w", days: 7 },
  { suffix: "d", days: 1 },
] as const;

/** The UTC day a "YYYY-MM-DD" key names, counted from the epoch. */
function dayIndex(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY);
}

/**
 * A label's matches per day over the window, or 0 when it has no history in it.
 *
 * The number behind matchRate, and what the columns are ordered by — the
 * formatted rate rounds to a single digit, so two labels that read the same can
 * still be told apart here.
 */
export function matchesPerDay(entry: MatchEntry | undefined, now: Date): number {
  const daily = entry?.daily_matches;
  if (!daily) return 0;
  const days = Object.keys(daily);
  if (!days.length) return 0;

  const today = Math.floor(now.getTime() / DAY);
  const earliest = Math.min(...days.map(dayIndex));
  const observed = today - earliest + 1;
  const window = Math.min(WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, observed));
  const from = today - window + 1;

  let total = 0;
  for (const day of days) {
    const index = dayIndex(day);
    if (index >= from && index <= today) total += daily[day];
  }
  return total > 0 ? total / window : 0;
}

/**
 * A label's match rate, as one small number and a unit — "~3/d", "~4/y", or "—"
 * when there is too little to report.
 *
 * The tilde is not decoration. This is an average over a window, rounded to a
 * single digit; a bare "4/m" would read as a count someone had made, and the
 * number is not that precise. Saying "about" is the honest form.
 *
 * Derived from the daily counts alone; last_matched_at says nothing about how
 * often. Days inside the window with no entry count as the zeroes they are, and
 * days before the label's first match are not counted at all.
 */
export function matchRate(entry: MatchEntry | undefined, now: Date): string {
  const perDay = matchesPerDay(entry, now);
  // Below roughly one a year there is no unit left that says anything useful.
  if (perDay * WINDOW_DAYS < 1) return NO_RATE;

  for (const unit of UNITS) {
    const value = Math.round(perDay * unit.days);
    if (value <= 9) return `~${value}/${unit.suffix}`;
  }
  // More than nine a day: the number stops being single-digit before the unit
  // stops being the right one.
  return `~${Math.round(perDay)}/d`;
}

/**
 * When a label last matched, relative to now — "Last matched today", or
 * "Never matched" when it has no history. A timestamp that cannot be read counts
 * as none: a broken store should not break the page.
 *
 * Counted in whole calendar days rather than elapsed hours, so a match from this
 * morning reads as today rather than as a number, and one from late last night
 * reads as yesterday rather than as a handful of hours. The exact moment stays
 * available in the card's native tooltip for anyone who wants it.
 */
export function lastMatched(entry: MatchEntry | undefined, now: Date): string {
  const at = entry?.last_matched_at;
  const then = at ? new Date(at) : null;
  if (!then || Number.isNaN(then.getTime())) return "Never matched";
  return `Last matched ${ago(calendarDaysApart(then, now))}`;
}

/**
 * Whole days between two moments, by the reader's own calendar. Local, because
 * "today" is a question about the clock on the wall; rounded, because a day
 * across a daylight-saving change is not twenty-four hours long.
 */
function calendarDaysApart(then: Date, now: Date): number {
  const midnight = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  return Math.round((midnight(now) - midnight(then)) / DAY);
}

function ago(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * The two pieces a card shows: the rate, which sits beside the label's name, and
 * when it last matched, which sits under it.
 *
 * `rate` is null when there is none to give, and the card then shows nothing
 * beside the name rather than a placeholder. That covers both a label that has
 * never matched and one whose matches have all aged out of the window — in each
 * case the line below says what happened, and inventing a rate would not.
 */
export function matchDisplay(
  entry: MatchEntry | undefined,
  now: Date,
): { rate: string | null; last: string } {
  const rate = matchRate(entry, now);
  return { rate: rate === NO_RATE ? null : rate, last: lastMatched(entry, now) };
}
