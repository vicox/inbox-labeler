/**
 * The shape of data/labels.json, and the pure derivations the UI needs from it.
 *
 * Nothing here reads the file or knows where it lives — see app/api/labels/route.ts
 * for that. Keeping the two apart is what lets the local file be swapped for an
 * authenticated backend later without touching the rendering.
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

/** One line from a detection label to a derived label that requires it. */
export type Connection = { from: string; to: string };

/**
 * Order by attention, high first. Labels of equal attention keep the order they
 * have in the file, so the policy still reads the way its author wrote it.
 */
export function byAttention(labels: Label[]): Label[] {
  return [...labels].sort(
    (a, b) => ATTENTION_ORDER.indexOf(a.attention) - ATTENTION_ORDER.indexOf(b.attention),
  );
}

/**
 * Every required_labels entry becomes one connection. A detection label may feed
 * any number of derived labels and a derived label may require any number of
 * detection labels, so this is a plain many-to-many edge list rather than pairs.
 *
 * A required label that names nothing in the policy is dropped: it cannot be
 * drawn, and the UI is not the place to report a broken policy.
 */
export function connectionsOf(labels: Label[]): Connection[] {
  const detection = new Set(
    labels.filter((l) => l.type === "detection").map((l) => l.label),
  );
  return labels
    .filter((l) => l.type === "derived")
    .flatMap((derived) =>
      (derived.required_labels ?? [])
        .filter((required) => detection.has(required))
        .map((required) => ({ from: required, to: derived.label })),
    );
}

/**
 * Split the detection labels into the ones a derived label requires and the ones
 * none does, and order the first group by the derived labels themselves: the
 * inputs of the first derived label come first, then those of the second, and so
 * on. Reading the two columns side by side then follows the same order, and each
 * derived label's inputs sit together.
 *
 * A detection label required by several derived labels appears once, with the
 * first that requires it. The labels no derived label requires keep the order
 * they were given.
 */
export function groupByDerived(detection: Label[], derived: Label[]) {
  const byName = new Map(detection.map((label) => [label.label, label]));
  const combined: Label[] = [];
  const taken = new Set<string>();

  for (const judgement of derived) {
    for (const required of judgement.required_labels ?? []) {
      const label = byName.get(required);
      if (!label || taken.has(required)) continue;
      taken.add(required);
      combined.push(label);
    }
  }

  return { combined, alone: detection.filter((label) => !taken.has(label.label)) };
}

/**
 * What to emphasise while `focused` is hovered or focused: the label itself, the
 * labels on the other side of its connections, and those connections. With
 * nothing focused every label is active and no connection is singled out.
 */
export function emphasis(focused: string | null, connections: Connection[]) {
  if (!focused) return { labels: null, connections: new Set<number>() };

  const labels = new Set([focused]);
  const active = new Set<number>();
  connections.forEach((connection, index) => {
    if (connection.from === focused) {
      labels.add(connection.to);
      active.add(index);
    } else if (connection.to === focused) {
      labels.add(connection.from);
      active.add(index);
    }
  });
  return { labels, connections: active };
}
