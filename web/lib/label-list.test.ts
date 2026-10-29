import assert from "node:assert/strict";
import test from "node:test";

import {
  byFrequency,
  connectionsOf,
  listsOf,
  type Attention,
  type Label,
} from "./label-list.ts";

function label(name: string, attention: Attention = "normal"): Label {
  return { label: name, type: "detection", attention, instruction: "x" };
}

/** Reads the order back as names, which is what the test is about. */
const order = (labels: Label[], rates: Record<string, number> = {}) =>
  byFrequency(labels, (l) => rates[l.label] ?? 0).map((l) => l.label);

test("the busier label comes first", () => {
  const labels = [label("rare"), label("busy"), label("middling")];
  assert.deepEqual(order(labels, { busy: 5, middling: 1, rare: 0.1 }), [
    "busy",
    "middling",
    "rare",
  ]);
});

test("labels that match equally often fall back to their names", () => {
  const labels = [label("Newsletter"), label("Delivery"), label("Marketing")];
  const same = { Newsletter: 0.3, Delivery: 0.3, Marketing: 0.3 };
  assert.deepEqual(order(labels, same), ["Delivery", "Marketing", "Newsletter"]);
});

test("labels that never matched land alphabetically at the foot", () => {
  const labels = [label("Wohnung"), label("busy"), label("Invoices"), label("Birthday")];
  assert.deepEqual(order(labels, { busy: 2 }), ["busy", "Birthday", "Invoices", "Wohnung"]);
});

test("attention has no bearing on the order, even where the names decide it", () => {
  // Equal frequencies, so the name is what orders these and attention is the only
  // thing left that could interfere. A tie-break on attention before the name
  // would reorder them; nothing else would.
  const same = { Birthday: 3, Invoices: 3, Wohnung: 3 };
  const alphabetical = ["Birthday", "Invoices", "Wohnung"];

  // Every arrangement of the three levels over the same three names, including the
  // ones that would put a `high` last and a `none` first if attention were read.
  const arrangements: Attention[][] = [
    ["high", "normal", "none"],
    ["none", "normal", "high"],
    ["normal", "high", "none"],
    ["none", "high", "normal"],
    ["high", "high", "high"],
    ["none", "none", "none"],
  ];

  for (const [first, second, third] of arrangements) {
    const labels = [
      label("Wohnung", first),
      label("Birthday", second),
      label("Invoices", third),
    ];
    assert.deepEqual(order(labels, same), alphabetical, `attention ${first}/${second}/${third}`);
  }
});

test("ordering does not disturb the array it was given", () => {
  const labels = [label("b"), label("a")];
  order(labels);
  assert.deepEqual(
    labels.map((l) => l.label),
    ["b", "a"],
  );
});

// --- relationships ----------------------------------------------------------

function derived(name: string, required: string[], recommended: string[] = []): Label {
  return {
    label: name,
    type: "derived",
    attention: "normal",
    instruction: "x",
    required_labels: required,
    recommended_labels: recommended,
  };
}

test("both kinds of reference become connections, required first", () => {
  const labels = [
    label("Delivery"),
    label("Imminent"),
    label("Travel"),
    derived("Delivery arriving soon", ["Delivery", "Imminent"], ["Travel"]),
  ];
  assert.deepEqual(connectionsOf(labels), [
    { from: "Delivery", to: "Delivery arriving soon", kind: "required" },
    { from: "Imminent", to: "Delivery arriving soon", kind: "required" },
    { from: "Travel", to: "Delivery arriving soon", kind: "recommended" },
  ]);
});

test("a reference to a label that does not exist is dropped", () => {
  const labels = [label("Delivery"), derived("Ghosted", ["Delivery", "Nowhere"], ["Nobody"])];
  assert.deepEqual(connectionsOf(labels), [
    { from: "Delivery", to: "Ghosted", kind: "required" },
  ]);
});

test("a detection label feeding two derived labels appears in both", () => {
  const labels = [
    label("Invoices"),
    label("Large amount"),
    derived("Large invoice", ["Invoices", "Large amount"]),
    derived("Any invoice", ["Invoices"]),
  ];
  const feeds = connectionsOf(labels)
    .filter((c) => c.from === "Invoices")
    .map((c) => c.to);
  assert.deepEqual(feeds, ["Large invoice", "Any invoice"]);
});

// --- two lists --------------------------------------------------------------
//
// The signed-in page shows detection labels and derived labels in two lists side
// by side. The kind of label decides the list; frequency alone decides the order
// within it.

/** Reads both lists back as names. */
const lists = (labels: Label[], rates: Record<string, number> = {}) => {
  const { detection, derived } = listsOf(labels, (l) => rates[l.label] ?? 0);
  return { detection: detection.map((l) => l.label), derived: derived.map((l) => l.label) };
};

test("each kind of label goes in its own list, busiest first", () => {
  const labels: Label[] = [
    label("Idle detection"),
    derived("Idle conclusion", ["Idle detection"]),
    label("Busy detection"),
    derived("Busy conclusion", ["Busy detection"]),
  ];
  const rates = { "Busy detection": 3, "Busy conclusion": 5, "Idle detection": 0.1 };
  assert.deepEqual(lists(labels, rates), {
    detection: ["Busy detection", "Idle detection"],
    derived: ["Busy conclusion", "Idle conclusion"],
  });
});

test("every role shares the detection list and one order, by frequency alone", () => {
  const labels: Label[] = [
    { ...label("Idle category"), role: "category" },
    { ...label("Middling attribute"), role: "attribute" },
    label("No role yet"),
    derived("Busy conclusion", ["Idle category"]),
  ];
  const rates = { "Busy conclusion": 5, "Middling attribute": 1, "No role yet": 0.5 };
  assert.deepEqual(lists(labels, rates), {
    detection: ["Middling attribute", "No role yet", "Idle category"],
    derived: ["Busy conclusion"],
  });
});

test("a kind with no labels is an empty list, not a missing one", () => {
  assert.deepEqual(lists([label("Invoices")]), { detection: ["Invoices"], derived: [] });
  assert.deepEqual(lists([derived("Large invoice", [])]), {
    detection: [],
    derived: ["Large invoice"],
  });
});
