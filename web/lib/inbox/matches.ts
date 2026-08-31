import { LabelError } from "./labels.ts";

/**
 * How often a label matches, and when it last did — the rules, not the storage.
 *
 * The timestamp handling, and what is stored — nothing else:
 *
 *     the label          the text, exactly as the policy spells it
 *     a calendar day     derived from the email's own timestamp, in UTC
 *     a count per day    how many matches that label had that day
 *     last_matched_at    the newest email timestamp the label has matched
 *
 * **No part of an email is stored.** Not the body, the subject, the sender, the
 * recipients, the message or thread id, the attachments, or anything else about
 * it. A day and a number cannot be traced back to a message, and that is the
 * point: the store answers "how often does this label fire" and can answer
 * nothing else.
 *
 * Because nothing identifies the email, reporting the same one twice counts it
 * twice. There is deliberately no deduplication, since the only way to have it
 * would be to keep the ids this design exists to avoid. If it matters, it belongs
 * at the boundary that knows about emails — not in the counter.
 */

/** One label's history, exactly as the store holds it and `get_matches` returns it. */
export type MatchHistory = {
  /** The newest email timestamp this label has matched, or null if it never has. */
  last_matched_at: string | null;
  /** Counts per UTC calendar day. A day with no matches is absent, never zero. */
  daily_matches: Record<string, number>;
};

/** Label text to its history. A label that has never matched is simply absent. */
export type Matches = Record<string, MatchHistory>;

/** A label with no history yet, which is a normal state rather than a gap. */
export function noHistory(): MatchHistory {
  return { last_matched_at: null, daily_matches: {} };
}

/**
 * Parses an ISO 8601 timestamp that carries a UTC offset.
 *
 * The offset is required, and that is the whole reason this function exists
 * rather than a bare `new Date(...)`. `2026-08-20T10:12:00` on its own is
 * twenty-six different moments depending on who wrote it, and a day count that
 * mixes them means nothing. Give it as `…Z` or as `…+02:00`.
 *
 * Sub-second precision is dropped: these timestamps are compared and stored at
 * second resolution, which is finer than a store aggregated by day needs.
 *
 * JavaScript's own parser is too permissive to lean on — it accepts a bare date
 * and quietly calls it midnight UTC, which is exactly the guess being refused
 * here — so the shape is checked before the value is.
 */
export function parseEmailTimestamp(value: unknown): Date {
  const text = String(value ?? "").trim();

  const shape = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/u.exec(
    text,
  );
  if (!shape) {
    // Told apart because they are different mistakes: one is not a timestamp,
    // the other is a timestamp missing the one thing that makes it a moment.
    const withoutOffset = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/u.test(text);
    throw new LabelError(
      withoutOffset
        ? `"${text}" has no UTC offset, so the day it counts towards would be a guess — ` +
          "write it as 2026-08-20T10:12:00Z or 2026-08-20T12:12:00+02:00"
        : `"${text}" is not an ISO 8601 timestamp — expected something like ` +
          "2026-08-20T10:12:00Z or 2026-08-20T12:12:00+02:00",
    );
  }

  const moment = new Date(text.replace(" ", "T"));
  if (Number.isNaN(moment.getTime())) {
    throw new LabelError(
      `"${text}" is not a real moment — check the month, day and hour are in range`,
    );
  }

  // Second resolution, matching what is stored and compared.
  return new Date(Math.floor(moment.getTime() / 1000) * 1000);
}

/** The canonical stored form, always UTC: 2026-08-20T10:12:00Z. */
export function formatTimestamp(moment: Date): string {
  return `${moment.toISOString().slice(0, 19)}Z`;
}

/** The UTC calendar day a match counts towards. */
export function dayOf(moment: Date): string {
  return moment.toISOString().slice(0, 10);
}

/**
 * A history with its days oldest first, so it reads and diffs the way the file
 * does.
 */
export function orderHistory(history: MatchHistory): MatchHistory {
  const days = Object.keys(history.daily_matches).sort();
  const daily: Record<string, number> = {};
  for (const day of days) daily[day] = history.daily_matches[day];
  return { last_matched_at: history.last_matched_at, daily_matches: daily };
}

/** Labels alphabetically ignoring case, each history ordered by day. */
export function orderMatches(matches: Matches): Matches {
  const ordered: Matches = {};
  for (const label of Object.keys(matches).sort((a, b) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
  )) {
    ordered[label] = orderHistory(matches[label]);
  }
  return ordered;
}

/**
 * Checks the labels named for one email.
 *
 * An email matching several labels is several matches — `Invoices`,
 * `Large amount` and `Large invoice` on one message are three independent counts
 * and are never collapsed. The same label twice is a different thing: one email
 * is one match per label, so it is the caller's mistake rather than two counts.
 */
export function checkRecordedLabels(labels: readonly string[]): string[] {
  if (!labels.length) {
    throw new LabelError("no labels given: name at least one label that matched");
  }
  return [...labels];
}

/** The complaint for the same label named twice in one email. */
export function duplicateLabel(label: string): LabelError {
  return new LabelError(
    `label "${label}" was given twice for the same email — one email is one match per label`,
  );
}
