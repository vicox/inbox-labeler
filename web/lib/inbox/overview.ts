import { matchesPerDay, type MatchEntry } from "../activity.ts";
import { normalise, sameLabel, stripNamespace, RESERVED_LABELS, type Label } from "./labels.ts";
import type { Matches } from "./matches.ts";

/**
 * Which one label represents an email, out of the several on it.
 *
 * `inbox-labeler-overview` groups already-processed mail under one heading per
 * email, and this decides which heading. Ranking rather than judgement: given the
 * same labels, the same model, the same history and the same ranking time, the
 * same label wins.
 *
 * **It never reads an email.** The input is the business labels a processing run
 * already put on the message; no instruction is evaluated and no label is added,
 * removed or reconsidered.
 *
 * It ranks against the model **as it stands now**, not as it stood when the
 * message was processed. Nothing here reads history the store does not keep: the
 * match history holds a label, a day and a count, and cannot say what a message
 * once matched. So editing a derived label's references, or a detection label's
 * role, can move old mail into a different overview section on the next run —
 * while the Gmail labels on that mail stay exactly as they are. This is a view,
 * and it is the only thing the current model changes about processed mail.
 */

/**
 * The four kinds of business label, highest priority first.
 *
 * A derived label is an interpretation of facts, so it says more about an email
 * than any single fact does; a category says what the mail is; an attribute says
 * something additionally true about it; and a detection label modelled before
 * roles existed says only that something was found. The priority is absolute: a
 * rarer category never overtakes a derived label, because rarity separates labels
 * inside one class and never between two.
 *
 * `no-role` is not a role — it is where a detection label goes when nobody has
 * decided yet whether it is a category or an attribute, the same grouping
 * `lib/label-graph.ts` shows on the signed-in page.
 */
export const MATCH_CLASSES = ["derived", "category", "attribute", "no-role"] as const;
export type MatchClass = (typeof MATCH_CLASSES)[number];

/** One email's grouping, as the overview reads it. */
export type EmailOverview = {
  /**
   * The label this email is grouped under, or null when it carries no business
   * label this user currently defines. Null is an answer, not a failure.
   */
  representative: string | null;
  /**
   * The email's other current business labels, ranked, for the row's metadata.
   * Never a heading, and never an influence on grouping.
   */
  secondary: string[];
  /**
   * Labels on the message that this user has no definition for — deleted or
   * renamed since it was processed. Named rather than dropped, but they take no
   * part in the ranking: there is no class to rank them in.
   */
  unknown: string[];
};

/** What kind of business label this is. Total: every label has exactly one. */
export function matchClass(label: Label): MatchClass {
  if (label.type === "derived") return "derived";
  return label.role ?? "no-role";
}

/**
 * How many of a derived label's **current** detection references are among the
 * labels on this message.
 *
 * Not a claim about what took part when the message was processed — nothing
 * records that, and this does not reconstruct it. It is a measure of how much of
 * what the derived label refers to today is visible on this message, which is
 * what makes one derived label a more specific fit for it than another.
 *
 * Required and recommended references count alike, once each, and one that is not
 * on the message does not count. Nothing here re-checks the gate: whether the
 * derived label belongs was decided at processing time.
 */
function presentReferences(label: Label, present: readonly string[]): number {
  const counted: string[] = [];
  for (const reference of [...(label.required_labels ?? []), ...(label.recommended_labels ?? [])]) {
    if (!present.some((one) => sameLabel(one, reference))) continue;
    if (counted.some((already) => sameLabel(already, reference))) continue;
    counted.push(reference);
  }
  return counted.length;
}

/**
 * The labels a caller named, in the form the ranking works with.
 *
 * Accepts either spelling — `Invoice` or `IL/Invoice` — because the caller is
 * reading Gmail label names off a message and the namespace is plumbing.
 * InboxLabeler's own two labels are dropped: `processed` and `no-match` are state
 * rather than meaning, so they are never a heading and never a secondary label.
 */
function businessLabels(given: readonly string[]): string[] {
  const labels: string[] = [];
  for (const value of given) {
    const label = normalise(stripNamespace(normalise(value)));
    if (!label) continue;
    if (Object.keys(RESERVED_LABELS).some((reserved) => sameLabel(label, reserved))) continue;
    if (labels.some((already) => sameLabel(already, label))) continue;
    labels.push(label);
  }
  return labels;
}

/**
 * Two label texts in reading order, and never equal unless they are one label.
 *
 * `localeCompare` alone is the order a reader expects — `apple` before `Zebra`,
 * accents where a dictionary puts them — but it is not a strict order over the
 * strings InboxLabeler treats as distinct: it answers 0 for a composed `é` and a
 * decomposed `e` + combining accent, which `sameLabel` reads as two labels
 * because nothing here normalises Unicode. Sorting is stable, so a 0 there would
 * leave the pair in the order the caller happened to pass them, and an overview
 * would depend on the order Gmail returned labels in.
 *
 * So the reading order decides whenever it has an opinion, identity decides when
 * it does not, and code points settle what is left. This orders labels; it does
 * not change what makes two of them the same.
 */
function byLabelText(one: string, other: string): number {
  const reading = one.localeCompare(other);
  if (reading !== 0) return reading;
  if (sameLabel(one, other)) return 0;
  return one < other ? -1 : 1;
}

/**
 * The known labels on one email, best representative first:
 *
 *   1. class — derived, then category, then attribute, then no-role
 *   2. references present on the message, more first — derived labels only
 *   3. rarity, rarer first
 *   4. the label's own text, ascending
 *
 * Steps 2 to 4 only ever compare labels of the same class, because step 1 has
 * already separated them. Nothing consults the email, its attention, the order
 * the store returned or the order the caller wrote.
 */
function rank(
  present: readonly string[],
  known: readonly Label[],
  perDay: (label: string) => number,
): Label[] {
  const ranked = present
    .map((text) => known.find((one) => sameLabel(one.label, text)))
    .filter((one): one is Label => Boolean(one))
    .map((label) => ({
      label,
      class: MATCH_CLASSES.indexOf(matchClass(label)),
      references: matchClass(label) === "derived" ? presentReferences(label, present) : 0,
      perDay: perDay(label.label),
    }));

  return ranked
    .sort(
      (a, b) =>
        a.class - b.class ||
        b.references - a.references ||
        a.perDay - b.perDay ||
        byLabelText(a.label.label, b.label.label),
    )
    .map((one) => one.label);
}

/**
 * The overview grouping for a batch of already-processed emails.
 *
 * One entry out per entry in, in the same order, so a caller keeps the
 * association between an email and its answer without naming the email. Nothing
 * about a message is passed in or returned — no id, no subject, no sender — for
 * the same reason the match history holds none.
 *
 * `now` is the moment rarity is measured against: `matchesPerDay` reads a rolling
 * window, so it is part of the answer rather than a detail of it.
 */
export function overviewOf(
  emails: readonly (readonly string[])[],
  labels: readonly Label[],
  matches: Matches,
  now: Date,
): EmailOverview[] {
  const history = new Map<string, MatchEntry>(
    Object.entries(matches).map(([label, entry]) => [normalise(label).toLowerCase(), entry]),
  );
  const perDay = (label: string) =>
    matchesPerDay(history.get(normalise(label).toLowerCase()), now);

  return emails.map((given) => {
    const present = businessLabels(given);
    const [best, ...rest] = rank(present, labels, perDay);

    return {
      representative: best?.label ?? null,
      secondary: rest.map((one) => one.label),
      unknown: present
        .filter((text) => !labels.some((one) => sameLabel(one.label, text)))
        .sort(byLabelText),
    };
  });
}
