import assert from "node:assert/strict";
import test from "node:test";

import type { Label } from "../label-stream.ts";
import { findLabel, labelHref, single } from "./screens.ts";

/**
 * A label's address, and what a URL is allowed to choose.
 *
 * A label's name is whatever the user said, so every awkward string has to
 * survive the trip into a link and back out of the query the page is given — and
 * a URL that names something no longer there has to find nothing, never
 * something else.
 */

/** What a page reads back from one of these links, as Next.js parses it. */
function query(href: string): URLSearchParams {
  return new URL(href, "http://localhost").searchParams;
}

const AWKWARD = [
  "Travel/Flights",
  "..",
  ".",
  "#1",
  "Action required?",
  "C++",
  "100%",
  "a&b=c",
  "Große Beträge",
  "𝔇𝔢𝔞𝔡𝔩𝔦𝔫𝔢",
];

test("a label's name survives the trip into its link and back", () => {
  for (const name of AWKWARD) {
    const href = labelHref(name);
    assert.ok(href.startsWith("/label?"), `${name} is not addressed by a query`);
    assert.equal(query(href).get("name"), name, `${name} came back as something else`);
  }
});

test("one value is an answer, and a list or nothing is not", () => {
  assert.equal(single("Invoices"), "Invoices");
  assert.equal(single(""), "");
  assert.equal(single(["a", "b"]), null);
  assert.equal(single(undefined), null);
});

const label = (name: string): Label => ({
  label: name,
  type: "detection",
  attention: "normal",
  instruction: `${name}, in their words.`,
});

test("a label is found by its stored name", () => {
  const labels = [label("Invoices"), label("Travel/Flights"), label("..")];
  for (const { label: name } of labels) {
    assert.equal(findLabel(labels, name)?.label, name);
  }
});

test("another case or spacing is the same label, because labels are unique ignoring both", () => {
  const labels = [label("Large amount")];
  for (const typed of ["large amount", "LARGE AMOUNT", "  Large   amount "]) {
    assert.equal(findLabel(labels, typed), labels[0], JSON.stringify(typed));
  }
});

test("a label that is not there finds nothing, not a neighbour", () => {
  const labels = [label("Invoices"), label("Invoices large")];
  for (const name of ["Invoice", "Invoices lar", "", "   ", "IL/Invoices"]) {
    assert.equal(findLabel(labels, name), null, JSON.stringify(name));
  }
  assert.equal(findLabel(labels, null), null);
  assert.equal(findLabel([], "Invoices"), null);
});
