import assert from "node:assert/strict";
import test from "node:test";

import type { Label } from "./labels.ts";
import type { Matches } from "./matches.ts";
import { matchClass, overviewOf, type EmailOverview } from "./overview.ts";

/**
 * Which label represents an email, and why that is never a judgement.
 *
 * Every test here fixes `now`, so the rarity window is the same one twice, and
 * names labels so that alphabetical order and the order they are passed in
 * disagree — an assertion that passed because the input happened to be sorted
 * would prove nothing.
 *
 * The ranking reads the model as it stands, so a few of these change a label and
 * expect already-labelled mail to be grouped differently. That is the intended
 * behaviour of a view, not classification reaching backwards.
 */

const NOW = new Date("2026-08-20T12:00:00Z");
const DAY = 86_400_000;

function detection(label: string, role?: "category" | "attribute"): Label {
  return { label, type: "detection", ...(role ? { role } : {}), attention: "normal", instruction: "x" };
}

function derived(label: string, required: string[] = [], recommended: string[] = []): Label {
  return {
    label,
    type: "derived",
    attention: "normal",
    instruction: "x",
    required_labels: required,
    recommended_labels: recommended,
  };
}

/** A history of `total` matches spread over the last thirty days. */
function history(total: number): Matches[string] {
  const daily: Record<string, number> = {};
  for (let i = 0; i < 30; i += 1) {
    daily[new Date(NOW.getTime() - i * DAY).toISOString().slice(0, 10)] = total / 30;
  }
  return { last_matched_at: null, daily_matches: daily };
}

/** Histories by label, so a test only names the labels whose rarity it is about. */
function matches(rates: Record<string, number>): Matches {
  return Object.fromEntries(Object.entries(rates).map(([label, total]) => [label, history(total)]));
}

/** One email, so a test reads as the question it is asking. */
function one(on: string[], labels: Label[], rates: Record<string, number> = {}): EmailOverview {
  const [result] = overviewOf([on], labels, matches(rates), NOW);
  return result;
}

// --- class priority --------------------------------------------------------

test("every label has exactly one class, and a detection label without a role has its own", () => {
  assert.equal(matchClass(derived("Large invoice")), "derived");
  assert.equal(matchClass(detection("Invoice", "category")), "category");
  assert.equal(matchClass(detection("Large amount", "attribute")), "attribute");
  assert.equal(matchClass(detection("Newsletter")), "no-role");
});

test("a derived label represents the email over any detection label", () => {
  const labels = [
    detection("Invoice", "category"),
    detection("Large amount", "attribute"),
    derived("Large invoice", ["Invoice", "Large amount"]),
  ];
  const result = one(["Invoice", "Large amount", "Large invoice"], labels);

  assert.equal(result.representative, "Large invoice");
  assert.deepEqual(result.secondary, ["Invoice", "Large amount"]);
});

test("a category represents the email over an attribute", () => {
  const labels = [detection("Invoice", "category"), detection("Action required", "attribute")];
  const result = one(["Action required", "Invoice"], labels);

  assert.equal(result.representative, "Invoice");
  assert.deepEqual(result.secondary, ["Action required"]);
});

test("an attribute represents the email over a detection label with no role", () => {
  const labels = [detection("Large amount", "attribute"), detection("Aaa legacy")];
  assert.equal(one(["Aaa legacy", "Large amount"], labels).representative, "Large amount");
});

test("rarity never lifts a label out of its class", () => {
  const labels = [
    detection("Invoice", "category"),
    detection("Aaa rare attribute", "attribute"),
    derived("Zzz common derived", ["Invoice"]),
  ];
  // The derived label fires constantly and the attribute almost never; the class
  // order decides anyway, and the alphabet would have gone the other way too.
  const result = one(["Aaa rare attribute", "Invoice", "Zzz common derived"], labels, {
    "Zzz common derived": 300,
    Invoice: 60,
    "Aaa rare attribute": 1,
  });

  assert.equal(result.representative, "Zzz common derived");
  assert.deepEqual(result.secondary, ["Invoice", "Aaa rare attribute"]);
});

// --- derived specificity, against the model as it stands -------------------

test("the derived label with more of its references on the message wins", () => {
  const labels = [
    detection("Invoices", "category"),
    detection("Large amount", "attribute"),
    detection("Action required", "attribute"),
    derived("Zzz two refs", ["Invoices"], ["Large amount"]),
    derived("Aaa three refs", ["Invoices"], ["Large amount", "Action required"]),
  ];
  const result = one(
    ["Invoices", "Large amount", "Action required", "Zzz two refs", "Aaa three refs"],
    labels,
  );

  assert.equal(result.representative, "Aaa three refs");
});

test("a recommended reference that is not on the message does not count", () => {
  const labels = [
    detection("Invoices", "category"),
    detection("Large amount", "attribute"),
    detection("Action required", "attribute"),
    derived("Aaa two refs", ["Invoices"], ["Large amount"]),
    derived("Zzz three refs", ["Invoices"], ["Large amount", "Action required"]),
  ];

  // With Action required on the message the fuller reference list wins; without
  // it the two are level on references, and the alphabet decides instead.
  assert.equal(
    one(["Invoices", "Large amount", "Action required", "Aaa two refs", "Zzz three refs"], labels)
      .representative,
    "Zzz three refs",
  );
  assert.equal(
    one(["Invoices", "Large amount", "Aaa two refs", "Zzz three refs"], labels).representative,
    "Aaa two refs",
  );
});

test("a required reference that is not on the message does not count either", () => {
  const labels = [
    detection("Invoices", "category"),
    detection("Large amount", "attribute"),
    derived("Aaa one ref", ["Invoices"]),
    derived("Zzz two refs", ["Invoices", "Large amount"]),
  ];

  assert.equal(
    one(["Invoices", "Aaa one ref", "Zzz two refs"], labels).representative,
    "Aaa one ref",
  );
  assert.equal(
    one(["Invoices", "Large amount", "Aaa one ref", "Zzz two refs"], labels).representative,
    "Zzz two refs",
  );
});

test("a reference naming a label this account no longer has counts for nothing", () => {
  const labels = [
    detection("Invoices", "category"),
    derived("Aaa refers to one", ["Invoices"]),
    derived("Zzz refers to a ghost", ["Invoices", "Gone"]),
  ];

  assert.equal(
    one(["Invoices", "Aaa refers to one", "Zzz refers to a ghost"], labels).representative,
    "Aaa refers to one",
  );
});

test("changing a derived label's references regroups mail that was already labelled", () => {
  const on = ["Invoices", "Large amount", "Aaa broad", "Zzz narrow"];
  const inputs = [detection("Invoices", "category"), detection("Large amount", "attribute")];

  const before = one(on, [
    ...inputs,
    derived("Aaa broad", ["Invoices"]),
    derived("Zzz narrow", ["Invoices"]),
  ]);
  const after = one(on, [
    ...inputs,
    derived("Aaa broad", ["Invoices"]),
    derived("Zzz narrow", ["Invoices"], ["Large amount"]),
  ]);

  assert.equal(before.representative, "Aaa broad");
  assert.equal(after.representative, "Zzz narrow");
});

test("changing a detection label's role regroups mail that was already labelled", () => {
  const on = ["Zzz receipts", "Aaa notice"];
  const asAttribute = one(on, [detection("Zzz receipts", "attribute"), detection("Aaa notice", "attribute")]);
  const asCategory = one(on, [detection("Zzz receipts", "category"), detection("Aaa notice", "attribute")]);

  assert.equal(asAttribute.representative, "Aaa notice");
  assert.equal(asCategory.representative, "Zzz receipts");
});

test("references decide nothing outside derived labels", () => {
  // Two categories, and the rarer one wins: there is no reference count to
  // compare, and a detection label is never given one.
  const labels = [detection("Invoice", "category"), detection("Delivery", "category")];
  const result = one(["Invoice", "Delivery"], labels, { Invoice: 300, Delivery: 3 });

  assert.equal(result.representative, "Delivery");
});

// --- rarity ----------------------------------------------------------------

test("labels of the same class are separated by rarity, rarer first", () => {
  const labels = [
    detection("Action required", "attribute"),
    detection("Large amount", "attribute"),
    detection("Imminent", "attribute"),
  ];
  const result = one(["Action required", "Large amount", "Imminent"], labels, {
    "Action required": 300,
    "Large amount": 30,
    Imminent: 3,
  });

  assert.equal(result.representative, "Imminent");
  assert.deepEqual(result.secondary, ["Large amount", "Action required"]);
});

test("a label with no history at all is the rarest there is", () => {
  const labels = [detection("Invoice", "category"), detection("Travel", "category")];
  assert.equal(one(["Invoice", "Travel"], labels, { Invoice: 30 }).representative, "Travel");
});

test("rarity is only reached once the derived labels agree on their references", () => {
  const labels = [
    detection("Invoices", "category"),
    detection("Large amount", "attribute"),
    derived("Aaa common", ["Invoices"], ["Large amount"]),
    derived("Zzz rare", ["Invoices"]),
  ];
  const result = one(["Invoices", "Large amount", "Aaa common", "Zzz rare"], labels, {
    "Aaa common": 300,
    "Zzz rare": 1,
  });

  assert.equal(result.representative, "Aaa common");
});

// --- the last tie-breaker --------------------------------------------------

test("labels tied on everything are settled by their text, ascending", () => {
  const labels = [
    detection("Newsletter", "category"),
    detection("Delivery", "category"),
    detection("Invoice", "category"),
  ];
  const same = { Newsletter: 30, Delivery: 30, Invoice: 30 };
  const result = one(["Newsletter", "Delivery", "Invoice"], labels, same);

  assert.equal(result.representative, "Delivery");
  assert.deepEqual(result.secondary, ["Invoice", "Newsletter"]);
});

test("the order the labels are passed in changes nothing", () => {
  const labels = [
    detection("Invoice", "category"),
    detection("Large amount", "attribute"),
    detection("Action required", "attribute"),
    derived("Large invoice", ["Invoice", "Large amount"]),
  ];
  const rates = { Invoice: 30, "Large amount": 30, "Action required": 30, "Large invoice": 30 };
  const forwards = one(["Invoice", "Large amount", "Action required", "Large invoice"], labels, rates);
  const backwards = one(["Large invoice", "Action required", "Large amount", "Invoice"], labels, rates);

  assert.deepEqual(backwards, forwards);
});

// --- known, unknown, and neither -------------------------------------------

test("processed and no-match take no part, in either spelling", () => {
  const labels = [detection("Invoice", "category")];
  const result = one(["IL/processed", "no-match", "IL/Invoice"], labels);

  assert.equal(result.representative, "Invoice");
  assert.deepEqual(result.secondary, []);
  assert.deepEqual(result.unknown, []);
});

test("processed and no-match are not unknown labels either", () => {
  const result = one(["IL/processed", "IL/no-match"], []);

  assert.equal(result.representative, null);
  assert.deepEqual(result.unknown, []);
});

test("the IL/ prefix is accepted and stripped, and a label is counted once", () => {
  const labels = [detection("Invoice", "category")];
  const result = one(["IL/Invoice", "Invoice"], labels);

  assert.equal(result.representative, "Invoice");
  assert.deepEqual(result.secondary, []);
  assert.deepEqual(result.unknown, []);
});

test("two labels are two labels, however alike their text looks", () => {
  // The store hands this function the text it holds each label under, so telling
  // them apart is reading the text rather than judging it. `store.test.ts` holds
  // the case that matters: a pair Postgres keeps apart and case folding does not.
  const labels = [detection("Invoice", "category"), detection("invoice", "category")];
  const result = one(["Invoice", "invoice"], labels);

  assert.equal(result.secondary.length, 1, "neither label was swallowed by the other");
  assert.deepEqual([result.representative, ...result.secondary].sort(), ["Invoice", "invoice"]);
});

test("a label this account no longer defines is named as unknown, not ranked", () => {
  const labels = [detection("Invoice", "category")];
  const result = one(["Zzz gone", "Invoice", "Aaa gone"], labels);

  assert.equal(result.representative, "Invoice");
  assert.deepEqual(result.secondary, []);
  assert.deepEqual(result.unknown, ["Aaa gone", "Zzz gone"]);
});

test("an unknown label never becomes the representative, however alone it is", () => {
  const result = one(["Zzz gone", "Aaa gone"], [detection("Invoice", "category")]);

  assert.equal(result.representative, null);
  assert.deepEqual(result.secondary, []);
  assert.deepEqual(result.unknown, ["Aaa gone", "Zzz gone"]);
});

test("an email with no business label at all has neither a representative nor an unknown", () => {
  const result = one([], [detection("Invoice", "category")]);

  assert.equal(result.representative, null);
  assert.deepEqual(result.secondary, []);
  assert.deepEqual(result.unknown, []);
});

test("an empty label model still answers: every label is unknown, none is refused", () => {
  const results = overviewOf([["Invoice", "Large amount"], ["IL/no-match"], []], [], {}, NOW);

  assert.deepEqual(results, [
    { representative: null, secondary: [], unknown: ["Invoice", "Large amount"] },
    { representative: null, secondary: [], unknown: [] },
    { representative: null, secondary: [], unknown: [] },
  ]);
});

// --- the tie-break is a strict order, not just an alphabetical one ---------
//
// Two labels a reader sees as identical and InboxLabeler counts as distinct: a
// composed e-acute, and an e followed by a combining accent. `localeCompare`
// answers 0 for the pair, and label identity does not normalise Unicode, so the
// final tie-break has to separate them itself — otherwise a stable sort leaves
// them in whatever order the caller passed, and the overview depends on Gmail.

const COMPOSED = "\u00e9";
const DECOMPOSED = "e\u0301";

test("the two spellings really are one reading order and two labels", () => {
  assert.equal(COMPOSED.localeCompare(DECOMPOSED), 0);
  assert.notEqual(COMPOSED, DECOMPOSED);
});

test("the representative does not depend on the order the pair was passed in", () => {
  const labels = [detection(COMPOSED, "category"), detection(DECOMPOSED, "category")];

  assert.equal(one([COMPOSED, DECOMPOSED], labels).representative, DECOMPOSED);
  assert.equal(one([DECOMPOSED, COMPOSED], labels).representative, DECOMPOSED);
});

test("secondary labels do not depend on the order the pair was passed in", () => {
  const labels = [
    derived("Wrapper"),
    detection(COMPOSED, "category"),
    detection(DECOMPOSED, "category"),
  ];
  const forwards = one(["Wrapper", COMPOSED, DECOMPOSED], labels);
  const backwards = one([DECOMPOSED, COMPOSED, "Wrapper"], labels);

  assert.deepEqual(forwards.secondary, [DECOMPOSED, COMPOSED]);
  assert.deepEqual(backwards.secondary, forwards.secondary);
});

test("unknown labels do not depend on the order the pair was passed in", () => {
  const forwards = one([COMPOSED, DECOMPOSED], []);
  const backwards = one([DECOMPOSED, COMPOSED], []);

  assert.deepEqual(forwards.unknown, [DECOMPOSED, COMPOSED]);
  assert.deepEqual(backwards.unknown, forwards.unknown);
});

test("ordinary alphabetical order is still a reader's, not a code point's", () => {
  // "apple" before "Zebra" is the whole point of comparing this way: by code
  // point every capital sorts ahead of every lowercase letter.
  const labels = [detection("Zebra", "category"), detection("apple", "category")];
  const result = one(["Zebra", "apple"], labels);

  assert.equal(result.representative, "apple");
  assert.deepEqual(result.secondary, ["Zebra"]);
});

// --- the batch -------------------------------------------------------------

test("one answer per email, in the order they were given", () => {
  const labels = [detection("Invoice", "category"), detection("Travel", "category")];
  const results = overviewOf([["Travel"], [], ["Invoice"]], labels, {}, NOW);

  assert.deepEqual(
    results.map((result) => result.representative),
    ["Travel", null, "Invoice"],
  );
});

test("the answer is three fields: nothing about a message, and no ranking internals", () => {
  const labels = [detection("Invoice", "category")];
  const [result] = overviewOf([["Invoice"]], labels, {}, NOW);

  assert.deepEqual(Object.keys(result).sort(), ["representative", "secondary", "unknown"]);
});
