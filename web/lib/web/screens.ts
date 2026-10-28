import { sameLabel } from "../inbox/labels.ts";

/**
 * Where the signed-in screens are, and which of the user's own labels a URL
 * names.
 *
 *     /                          the stream: every label, busiest first
 *     /label?name=Invoices       one label
 *
 * ## A query parameter, not a path segment
 *
 * A label's name is whatever the user said. `Travel/Flights` is a valid label —
 * Gmail nests it — and a path segment carries a `/` worst of all; a name such as
 * `#1` or `..` fares no better. `URLSearchParams` carries any string there and
 * back.
 *
 * ## A URL chooses, it never authorizes
 *
 * The label is looked up in what the page has already read for the signed-in
 * visitor. A value from the query decides *which* of their labels is shown, never
 * whose — there is nothing here a URL could use to reach anyone else's — and
 * choosing writes nothing.
 */

/** One label's screen. */
export function labelHref(name: string): string {
  return `/label?${new URLSearchParams({ name })}`;
}

/**
 * One search-parameter value, or nothing.
 *
 * Next.js hands a repeated parameter (`?name=a&name=b`) over as a list, and a
 * page given two names has no honest way to pick one, so a list is no answer.
 */
export function single(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The label a URL names, by the rule the store identifies labels by.
 *
 * Every link is written from the stored name, so it always finds its label. A
 * name typed by hand in another case or spacing finds the same label too, because
 * labels are unique ignoring both (`sameLabel`) — there is only one it can mean.
 * A name that has since been renamed or deleted finds nothing rather than a guess.
 */
export function findLabel<T extends { label: string }>(
  labels: readonly T[],
  name: string | null,
): T | null {
  if (name === null) return null;
  return labels.find((label) => sameLabel(label.label, name)) ?? null;
}
