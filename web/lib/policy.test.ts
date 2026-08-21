import assert from "node:assert/strict";
import test from "node:test";

import { byRelevance, type Attention, type Label } from "./policy.ts";

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
