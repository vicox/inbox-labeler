/**
 * The shape of a label, and the pure derivations the UI needs from a set of them.
 *
 * Nothing here reads anything or knows where a label comes from, which is what let
 * the local file this was first written against be swapped for the signed-in user's
 * own store without touching the rendering. It matches `lib/inbox/labels.ts` field
 * for field; this is the view's copy of the shape, not a second definition of what
 * a label is.
 */

export const ATTENTION_ORDER = ["high", "normal", "none"] as const;

export type Attention = (typeof ATTENTION_ORDER)[number];

export type Label = {
  label: string;
  type: "detection" | "derived";
  attention: Attention;
  instruction: string;
  /** Derived labels only: the detection labels that must all have matched. */
  required_labels?: string[];
  recommended_labels?: string[];
};

/**
 * One relationship, from a detection label to a derived label that draws on it.
 * `kind` says how: a required label gates the derived label, a recommended one is
 * offered as context.
 */
export type Connection = { from: string; to: string; kind: "required" | "recommended" };

/**
 * The order a column is read in, most worth looking at first: what the label
 * asks of you, then how often it fires, then its name.
 *
 * Attention leads because it is the label's own declaration about itself. The
 * rate breaks the ties within a level, so a busy label is not buried among quiet
 * ones. The name breaks what is left, which is what puts every label that has
 * never matched into a predictable alphabetical block at the foot of its level
 * rather than in file order nobody can see.
 *
 * `perDay` is passed in rather than read here: how often a label matches is not
 * something the policy knows.
 */
export function byRelevance(labels: Label[], perDay: (label: Label) => number): Label[] {
  return [...labels].sort(
    (a, b) =>
      ATTENTION_ORDER.indexOf(a.attention) - ATTENTION_ORDER.indexOf(b.attention) ||
      perDay(b) - perDay(a) ||
      a.label.localeCompare(b.label),
  );
}

/**
 * Every reference a derived label makes becomes one connection — required ones
 * first, then recommended. A detection label may feed any number of derived
 * labels and a derived label may draw on any number of detection labels, so this
 * is a plain many-to-many edge list rather than pairs.
 *
 * Both kinds are here because both are real: a recommended label is used by the
 * derived label that names it, and leaving it out would hide that from anything
 * reading this — which side is emphasised on hover, and which relationships a
 * card can name.
 *
 * A reference that names nothing in the policy is dropped. The UI is not the
 * place to report a broken policy.
 */
export function connectionsOf(labels: Label[]): Connection[] {
  const detection = new Set(
    labels.filter((l) => l.type === "detection").map((l) => l.label),
  );
  return labels
    .filter((l) => l.type === "derived")
    .flatMap((derived) =>
      (
        [
          ...(derived.required_labels ?? []).map((name) => ({ name, kind: "required" } as const)),
          ...(derived.recommended_labels ?? []).map(
            (name) => ({ name, kind: "recommended" } as const),
          ),
        ] as { name: string; kind: Connection["kind"] }[]
      )
        .filter((reference) => detection.has(reference.name))
        .map((reference) => ({ from: reference.name, to: derived.label, kind: reference.kind })),
    );
}

/**
 * Which labels to emphasise while `focused` is hovered or focused: itself, and
 * whatever sits on the other side of its relationships. Null means nothing is
 * focused and every label stands at full strength.
 */
export function emphasis(focused: string | null, connections: Connection[]): Set<string> | null {
  if (!focused) return null;

  const labels = new Set([focused]);
  for (const connection of connections) {
    if (connection.from === focused) labels.add(connection.to);
    else if (connection.to === focused) labels.add(connection.from);
  }
  return labels;
}
