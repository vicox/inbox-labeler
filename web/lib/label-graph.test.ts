import assert from "node:assert/strict";
import test from "node:test";

import {
  byRelevance,
  connectionsOf,
  groupLabels,
  groupOf,
  type Attention,
  type Label,
} from "./label-graph.ts";

function label(name: string, attention: Attention = "normal"): Label {
  return { label: name, type: "detection", attention, instruction: "x" };
}

/** Reads the order back as names, which is what the test is about. */
const order = (labels: Label[], rates: Record<string, number> = {}) =>
  byRelevance(labels, (l) => rates[l.label] ?? 0).map((l) => l.label);

test("attention leads, high before normal before none", () => {
  const labels = [label("quiet", "none"), label("plain"), label("loud", "high")];
  assert.deepEqual(order(labels), ["loud", "plain", "quiet"]);
});

test("within a level the busier label comes first", () => {
  const labels = [label("rare"), label("busy"), label("middling")];
  assert.deepEqual(order(labels, { busy: 5, middling: 1, rare: 0.1 }), [
    "busy",
    "middling",
    "rare",
  ]);
});

test("a busy label never outranks a level above it", () => {
  const labels = [label("busy"), label("idle", "high")];
  assert.deepEqual(order(labels, { busy: 99 }), ["idle", "busy"]);
});

test("labels that match equally often fall back to their names", () => {
  const labels = [label("Newsletter"), label("Delivery"), label("Marketing")];
  const same = { Newsletter: 0.3, Delivery: 0.3, Marketing: 0.3 };
  assert.deepEqual(order(labels, same), ["Delivery", "Marketing", "Newsletter"]);
});

test("labels that never matched land alphabetically at the foot of their level", () => {
  const labels = [
    label("Wohnung"),
    label("busy"),
    label("Invoices"),
    label("Birthday", "high"),
  ];
  assert.deepEqual(order(labels, { busy: 2 }), ["Birthday", "busy", "Invoices", "Wohnung"]);
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

// --- the groups the signed-in page reads in --------------------------------
//
// Tested here rather than through the rendered page: the grouping is where a
// label could be lost or shown twice, and it is a pure function of the labels.

/** A detection label with a role, or deliberately without one. */
function detection(name: string, role?: "category" | "attribute"): Label {
  return { label: name, type: "detection", ...(role ? { role } : {}), attention: "normal", instruction: "x" };
}

function derivedLabel(name: string, required: string[] = []): Label {
  return {
    label: name,
    type: "derived",
    attention: "normal",
    instruction: "x",
    required_labels: required,
    recommended_labels: [],
  };
}

/** The groups as `{ key: [names] }`, which is what these tests are about. */
const grouped = (labels: Label[], rates: Record<string, number> = {}) =>
  Object.fromEntries(
    groupLabels(labels, (l) => rates[l.label] ?? 0).map((g) => [g.key, g.labels.map((l) => l.label)]),
  );

test("each kind of label lands in its own group", () => {
  const labels = [
    detection("Invoice", "category"),
    detection("Deadline", "attribute"),
    derivedLabel("Large invoice", ["Invoice"]),
  ];

  assert.deepEqual(grouped(labels), {
    category: ["Invoice"],
    attribute: ["Deadline"],
    derived: ["Large invoice"],
  });
});

test("a detection label with no role goes to No role, and stays a detection label", () => {
  const legacy = detection("Legacy");
  assert.equal("role" in legacy, false, "the fixture really has no role");

  const groups = groupLabels([detection("Invoice", "category"), legacy], () => 0);
  const noRole = groups.find((g) => g.key === "no-role");

  assert.deepEqual(noRole?.labels.map((l) => l.label), ["Legacy"]);
  // Grouped, not changed: nothing infers a role, and the label is untouched.
  assert.equal(noRole?.labels[0].type, "detection");
  assert.equal("role" in noRole!.labels[0], false);
  assert.equal(legacy.role, undefined);
});

test("No role is absent when every detection label has one", () => {
  const groups = groupLabels(
    [detection("Invoice", "category"), detection("Deadline", "attribute")],
    () => 0,
  );
  assert.equal(groups.some((g) => g.key === "no-role"), false);
  assert.deepEqual(groups.map((g) => g.key), ["category", "attribute"]);
});

test("every label appears exactly once, and none is dropped", () => {
  const labels = [
    detection("Invoice", "category"),
    detection("Delivery", "category"),
    detection("Deadline", "attribute"),
    detection("Legacy one"),
    detection("Legacy two"),
    derivedLabel("Large invoice", ["Invoice"]),
  ];

  const shown = groupLabels(labels, () => 0).flatMap((g) => g.labels.map((l) => l.label));

  assert.equal(shown.length, labels.length, "no label is shown twice and none vanishes");
  assert.deepEqual([...shown].sort(), labels.map((l) => l.label).sort());
});

test("the groups come in reading order, and each is ordered by relevance", () => {
  const labels = [
    detection("Rare", "category"),
    detection("Busy", "category"),
    detection("Deadline", "attribute"),
    detection("Legacy"),
    derivedLabel("Large invoice"),
  ];

  const groups = groupLabels(labels, (l) => ({ Busy: 9, Rare: 0.1 })[l.label] ?? 0);
  assert.deepEqual(groups.map((g) => g.key), ["category", "attribute", "derived", "no-role"]);
  // byRelevance inside the group, unchanged: busier first at the same attention.
  assert.deepEqual(groups[0].labels.map((l) => l.label), ["Busy", "Rare"]);
});

test("a derived label keeps the references the card and the detail read", () => {
  const labels = [
    detection("Invoice", "category"),
    detection("Large amount", "attribute"),
    derivedLabel("Large invoice", ["Invoice", "Large amount"]),
  ];

  const shown = groupLabels(labels, () => 0).find((g) => g.key === "derived")?.labels[0];
  assert.deepEqual(shown?.required_labels, ["Invoice", "Large amount"]);
  assert.deepEqual(shown?.recommended_labels, []);
  // And the edge list the card renders from still finds both.
  assert.deepEqual(
    connectionsOf(labels).filter((c) => c.to === "Large invoice").map((c) => c.from),
    ["Invoice", "Large amount"],
  );
});

test("no labels means no groups, so the page falls to its own empty state", () => {
  assert.deepEqual(groupLabels([], () => 0), []);
});

/**
 * `groupOf` decides which section of the page a label is shown in — four of them,
 * and no colour among them: a category, an attribute and a role-less detection
 * label all render on the one detection surface, and only their type would change
 * that. What these protect is the sorting, and the one input that must never
 * reach it.
 */
test("a group per kind of label, and no fifth", () => {
  assert.equal(groupOf(detection("Travel", "category")), "category");
  assert.equal(groupOf(detection("Imminent", "attribute")), "attribute");
  assert.equal(groupOf(derivedLabel("Large invoice")), "derived");
  // Modelled before roles existed: it gets its own section rather than being
  // hidden or guessed at, and it is a detection label like any other.
  assert.equal(groupOf(detection("Newsletter")), "no-role");
});

test("attention never decides the group", () => {
  for (const attention of ["high", "normal", "none"] as const) {
    for (const role of ["category", "attribute"] as const) {
      assert.equal(groupOf({ ...detection("X", role), attention }), role);
    }
    assert.equal(groupOf({ ...derivedLabel("D"), attention }), "derived");
    assert.equal(groupOf({ ...detection("L"), attention }), "no-role");
  }
});
