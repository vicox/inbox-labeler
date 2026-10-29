/**
 * The shape of a label, and the pure derivations the UI needs from a set of them.
 *
 * Nothing here reads anything or knows where a label comes from, which is what let
 * the local file this was first written against be swapped for the signed-in user's
 * own store without touching the rendering. It matches `lib/inbox/labels.ts` field
 * for field; this is the view's copy of the shape, not a second definition of what
 * a label is.
 */

export const ATTENTION_LEVELS = ["high", "normal", "none"] as const;

export type Attention = (typeof ATTENTION_LEVELS)[number];

export type Label = {
  label: string;
  type: "detection" | "derived";
  /**
   * Detection labels only: whether the fact is a category — what the email is or
   * is about — or an attribute — something additionally true about it.
   *
   * Optional, because a detection label created before the distinction existed has
   * none until somebody decides with the user which it is. Anything rendering it
   * has to cope with its absence rather than assume a default.
   */
  role?: "category" | "attribute";
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
 * The order each list is read in: busiest first, then by name.
 *
 * How often a label matches is the one thing about it that is worth ranking, and
 * it is what a reader is looking for — which of these is actually doing work. The
 * name breaks ties, which is what puts every label that has never matched into a
 * predictable alphabetical block at the foot of the list rather than in an order
 * nobody can see. Two labels matching equally often always come out the same way
 * round.
 *
 * What a label asks of you does not come into it, and neither does its role.
 * `attention` is a request about mail, not a claim about the label being more
 * worth reading than its neighbour, and ranking by it buried busy labels under
 * idle ones that happened to ask for more. A detection label's role is on its own
 * screen; sorting by it as well would split the detection list into sections.
 *
 * `perDay` is passed in rather than read here: how often a label matches is not
 * something a label carries.
 */
export function byFrequency(labels: Label[], perDay: (label: Label) => number): Label[] {
  return [...labels].sort((a, b) => perDay(b) - perDay(a) || a.label.localeCompare(b.label));
}

/**
 * The two lists the signed-in page shows side by side: detection labels and
 * derived labels, each in `byFrequency` order.
 *
 * The kind of label decides which list it is in and nothing else. Within a list
 * the order is the one above, so a category, an attribute and a detection label
 * with no role yet share the detection list and one order.
 */
export function listsOf(
  labels: Label[],
  perDay: (label: Label) => number,
): { detection: Label[]; derived: Label[] } {
  const ordered = byFrequency(labels, perDay);
  return {
    detection: ordered.filter((label) => label.type === "detection"),
    derived: ordered.filter((label) => label.type === "derived"),
  };
}

/**
 * Every reference a derived label makes becomes one connection — required ones
 * first, then recommended. A detection label may feed any number of derived
 * labels and a derived label may draw on any number of detection labels, so this
 * is a plain many-to-many edge list rather than pairs.
 *
 * Both kinds are here because both are real: a recommended label is used by the
 * derived label that names it, and leaving it out would hide that from anything
 * reading this — such as which relationships a card can name.
 *
 * A reference naming a label this user does not have is dropped. The UI is not
 * the place to report a reference that points at nothing.
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
