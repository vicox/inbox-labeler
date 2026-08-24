import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ATTENTION_LEVELS,
  DEFAULT_ATTENTION,
  DEFAULT_TYPE,
  GMAIL_NAMESPACE,
  LABEL_TYPES,
  REFERENCE_FIELDS,
  RESERVED_LABELS,
} from "./labels.ts";
import { dayOf, formatTimestamp, parseEmailTimestamp } from "./matches.ts";

/**
 * The hosted implementation against the local one.
 *
 * `skills/inbox-labeler/labels.py` and `matches.py` are the reference: the CLI
 * and this endpoint are two ways into one product, so a label the CLI accepts has
 * to be a label this accepts. The rules are written twice — a build step bridging
 * Python and TypeScript for six field names would cost more than it saves — and
 * this file is what makes that safe, by reading the Python source and checking
 * the vocabulary has not drifted apart.
 *
 * It reads the source rather than running it, deliberately: `npm test` should not
 * need a Python interpreter. That means it guards the vocabulary, which is what
 * realistically drifts when someone adds an attention level or a label type, and
 * not the behaviour, which the store's own tests cover against the documented
 * semantics.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const python = (name: string) => readFileSync(`${here}../../../skills/inbox-labeler/${name}`, "utf8");

const LABELS_PY = python("labels.py");
const MATCHES_PY = python("matches.py");

/** The strings of a Python tuple or list literal assigned to `name`. */
function pythonSequence(source: string, name: string): string[] {
  const assignment = new RegExp(`^${name}\\s*=\\s*\\(([^)]*)\\)`, "m").exec(source);
  assert.ok(assignment, `${name} is no longer a tuple literal in the Python source`);
  return [...assignment[1].matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

/** The keys of a Python dict literal assigned to `name`. */
function pythonDictKeys(source: string, name: string): string[] {
  const start = source.indexOf(`${name} = {`);
  assert.notEqual(start, -1, `${name} is no longer a dict literal in the Python source`);
  const body = source.slice(start, source.indexOf("\n}", start));
  return [...body.matchAll(/^\s{4}"([^"]+)":/gm)].map((match) => match[1]);
}

/** The string assigned to `name`. */
function pythonString(source: string, name: string): string {
  const assignment = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(source);
  assert.ok(assignment, `${name} is no longer a plain string in the Python source`);
  return assignment[1];
}

test("the attention levels are the same, in the same priority order", () => {
  // The order is not cosmetic: it is the priority aggregation follows, so two
  // implementations disagreeing about it would disagree about what a message asks.
  assert.deepEqual([...ATTENTION_LEVELS], pythonSequence(LABELS_PY, "ATTENTION_LEVELS"));
});

test("the default attention is the same", () => {
  assert.equal(DEFAULT_ATTENTION, pythonString(LABELS_PY, "DEFAULT_ATTENTION"));
});

test("the label types are the same", () => {
  assert.deepEqual([...LABEL_TYPES].sort(), pythonDictKeys(LABELS_PY, "LABEL_TYPES").sort());
});

test("the default label type is the same", () => {
  assert.equal(DEFAULT_TYPE, pythonString(LABELS_PY, "DEFAULT_TYPE"));
});

test("the reserved system labels are the same", () => {
  assert.deepEqual([...Object.keys(RESERVED_LABELS)].sort(), pythonDictKeys(LABELS_PY, "RESERVED_LABELS").sort());
});

test("the Gmail namespace is the same", () => {
  assert.equal(GMAIL_NAMESPACE, pythonString(LABELS_PY, "GMAIL_NAMESPACE"));
});

test("the reference fields are the ones the derived type declares", () => {
  // Read from the type's own entry rather than a separate constant, because that
  // is where Python declares them.
  const derived = LABELS_PY.slice(LABELS_PY.indexOf('"derived": {'));
  const references = /"references": \(([^)]*)\)/.exec(derived);
  assert.ok(references);
  assert.deepEqual(
    [...REFERENCE_FIELDS],
    [...references[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  );
});

test("the stored timestamp format is the same", () => {
  // Python writes strftime patterns; the equivalent here is a fixed slice of an
  // ISO string, so the check is that both describe the same shape.
  assert.equal(pythonString(MATCHES_PY, "TIMESTAMP_FORMAT"), "%Y-%m-%dT%H:%M:%SZ");
  assert.equal(formatTimestamp(new Date("2026-08-20T10:12:00Z")), "2026-08-20T10:12:00Z");
});

test("the stored day format is the same", () => {
  assert.equal(pythonString(MATCHES_PY, "DAY_FORMAT"), "%Y-%m-%d");
  assert.equal(dayOf(new Date("2026-08-20T10:12:00Z")), "2026-08-20");
});

test("timestamps are normalised the way the local implementation normalises them", () => {
  // The cases matches.py's docstring calls out: an offset is required, it is
  // converted to UTC, and sub-second precision is dropped.
  assert.equal(formatTimestamp(parseEmailTimestamp("2026-08-20T12:12:00+02:00")), "2026-08-20T10:12:00Z");
  assert.equal(formatTimestamp(parseEmailTimestamp("2026-08-20T10:12:00.987Z")), "2026-08-20T10:12:00Z");
  assert.equal(dayOf(parseEmailTimestamp("2026-08-21T01:30:00+02:00")), "2026-08-20");
});

test("the local implementation still states the semantics this one relies on", () => {
  // Asserting the documentation, the way the skill's own test suite does: these
  // are the promises the hosted store was built to keep, and they live in prose.
  // Normalised first, because the prose is wrapped: a phrase may straddle a line
  // break, pick up the `#` that continues a comment, or carry the backslash that
  // escapes an apostrophe inside a Python string.
  const prose = `${LABELS_PY}\n${MATCHES_PY}`
    // A backslash escaping an apostrophe disappears; a `#` continuing a comment
    // becomes the space it stands in for. Then the wrapping itself collapses.
    .replace(/\\/g, "")
    .replace(/#/g, " ")
    .replace(/\s+/g, " ");

  for (const promise of [
    "No part of an email is stored",
    "there is deliberately no deduplication here",
    "must never drag last_matched_at backwards",
    "a label's type is immutable",
  ]) {
    assert.ok(prose.includes(promise), `the Python source no longer says "${promise}"`);
  }
});
