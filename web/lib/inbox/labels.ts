/**
 * What a label is, and every rule about one that does not need a database.
 *
 * This is the definition: what a label is, what spellings are accepted, and how
 * one is rejected. Every way into the product goes through it — the MCP tools, the
 * signed-in page, the store — so there is one answer to "is this a valid label"
 * rather than one per caller. `store/` adds only what needs the database.
 *
 * The field names are snake_case because they are the label's own field names,
 * the ones an MCP client passes and reads back, not this language's.
 * `lib/label-graph.ts` describes the same shape for the web UI; the two agree because
 * they are both descriptions of one document.
 */

/** The Gmail namespace InboxLabeler owns. Labels are stored without it. */
export const GMAIL_NAMESPACE = "IL/";

/**
 * What a label asks of the user, lowest priority first.
 *
 * The order is the priority aggregation follows: `normal` is the absence of a
 * request, so any label that does ask for something outranks it, and `high`
 * outranks `none`. Nothing here aggregates — `inbox-labeler-attention` does, per
 * message — but the order is part of the vocabulary and belongs with it.
 */
export const ATTENTION_LEVELS = ["normal", "none", "high"] as const;
export type Attention = (typeof ATTENTION_LEVELS)[number];
export const DEFAULT_ATTENTION: Attention = "normal";

/** How a label decides whether it applies. */
export const LABEL_TYPES = ["detection", "derived"] as const;
export type LabelType = (typeof LABEL_TYPES)[number];
export const DEFAULT_TYPE: LabelType = "detection";

/**
 * What a detection label's fact *is*, which is a different question from how it
 * was found.
 *
 * A category answers "what kind of email is this" — `Invoice`, `Delivery`,
 * `Newsletter`, `Travel`. An attribute answers "what does this email contain,
 * indicate or require" — `Action required`, `Deadline`, `Large amount`. The
 * difference is which question the label's own instruction is deciding, not which
 * words its name is made of.
 *
 * Neither is exclusive and neither is a bucket: one email can match several
 * categories and several attributes, and matching remains one independent decision
 * per label. Role changes how a matched fact is *read*, never whether it matched.
 *
 * Only detection labels have one. A derived label is already an interpretation of
 * detection facts, so asking what kind of fact it is has no answer.
 */
export const DETECTION_ROLES = ["category", "attribute"] as const;
export type DetectionRole = (typeof DETECTION_ROLES)[number];

/**
 * InboxLabeler's own two labels.
 *
 * Internal state rather than anything a user models, spelled lowercase — the
 * convention that keeps them apart from the readable phrases users write — and
 * reserved, so no label may resolve to one of them.
 */
export const RESERVED_LABELS: Readonly<Record<string, string>> = {
  processed: "InboxLabeler's processing state",
  "no-match": "InboxLabeler's evaluation outcome",
};

/** Which reference lists a type carries. A detection label carries none. */
export const REFERENCE_FIELDS = ["required_labels", "recommended_labels"] as const;
export type ReferenceField = (typeof REFERENCE_FIELDS)[number];

/** A label, exactly as the store holds one and `get_labels` returns it. */
export type Label = {
  label: string;
  type: LabelType;
  /**
   * Detection labels only: whether the fact is a category or an attribute.
   *
   * Optional, and deliberately so. Every detection label created from now on has
   * one — `checkRole` refuses a new one without it — but accounts predate the
   * distinction, and their labels are read and used exactly as before until
   * somebody decides with the user which role each plays. Absent means unmodelled,
   * never a default.
   */
  role?: DetectionRole;
  attention: Attention;
  instruction: string;
  /** Derived labels only: the detection labels that must all have matched. */
  required_labels?: string[];
  /** Derived labels only: detection labels offered as context when they matched. */
  recommended_labels?: string[];
};

/**
 * Something the caller got wrong, phrased for them.
 *
 * Its own class so a store can tell a rejected label from a database failure,
 * and so the MCP tools can answer one as the caller's problem and the other as
 * ours. The messages are the ones the product uses everywhere, so a client and a
 * reader of the skills meet one vocabulary of complaints rather than two.
 */
export class LabelError extends Error {
  override readonly name = "LabelError";
}

// --- identity --------------------------------------------------------------

/** Trim the ends and collapse inner runs of whitespace to single spaces. */
export function normalise(label: unknown): string {
  return String(label ?? "").split(/\s+/).filter(Boolean).join(" ");
}

/** Labels identify case-insensitively, so "large amount" is "Large amount". */
export function sameLabel(one: string, other: string): boolean {
  return normalise(one).toLowerCase() === normalise(other).toLowerCase();
}

/** Remove exactly one leading `IL/`, if present. */
export function stripNamespace(label: string): string {
  return label.slice(0, GMAIL_NAMESPACE.length).toLowerCase() === GMAIL_NAMESPACE.toLowerCase()
    ? label.slice(GMAIL_NAMESPACE.length)
    : label;
}

/** Resolve a label to the Gmail label InboxLabeler applies, spaces and all. */
export function gmailLabel(label: string): string {
  return GMAIL_NAMESPACE + label;
}

// --- the rules that need nothing but the value -----------------------------

/**
 * Checks a label's own text, returning it normalised.
 *
 * Everything here is decidable from the string alone. Uniqueness and references
 * need to know what else exists, so they belong to the store, which has the
 * transaction to check them in.
 */
export function checkLabelText(value: unknown): string {
  const label = normalise(value);

  if (!label) throw new LabelError("label must not be empty");

  if (label.slice(0, GMAIL_NAMESPACE.length).toLowerCase() === GMAIL_NAMESPACE.toLowerCase()) {
    const without = stripNamespace(label);
    throw new LabelError(
      `label is stored without the ${GMAIL_NAMESPACE} prefix, which InboxLabeler adds for Gmail` +
        (without ? ` — use "${without}" instead of "${label}"` : ""),
    );
  }
  if (label.startsWith("/") || label.endsWith("/") || label.includes("//")) {
    throw new LabelError(
      `label must not start or end with '/' or contain '//' (it becomes "${gmailLabel(label)}" in Gmail)`,
    );
  }
  for (const [reserved, purpose] of Object.entries(RESERVED_LABELS)) {
    if (sameLabel(label, reserved)) {
      throw new LabelError(
        `"${label}" is a reserved system label: ${gmailLabel(reserved)} is ${purpose}, ` +
          "not something a label may model — choose a different label",
      );
    }
  }
  return label;
}

/** Checks an attention level, defaulting an absent one. */
export function checkAttention(value: unknown): Attention {
  const attention = normalise(value).toLowerCase() || DEFAULT_ATTENTION;
  if (!(ATTENTION_LEVELS as readonly string[]).includes(attention)) {
    throw new LabelError(
      `unknown attention "${attention}" — levels, lowest priority first: ${ATTENTION_LEVELS.join(", ")}`,
    );
  }
  return attention as Attention;
}

/** Checks a label type, defaulting an absent one. */
export function checkType(value: unknown): LabelType {
  const type = normalise(value).toLowerCase() || DEFAULT_TYPE;
  if (!(LABEL_TYPES as readonly string[]).includes(type)) {
    throw new LabelError(
      `unknown label type "${type}" — supported types: ${[...LABEL_TYPES].sort().join(", ")}`,
    );
  }
  return type as LabelType;
}

/**
 * Checks a detection label's role.
 *
 * `existing` is the label being changed, or `undefined` when one is being created,
 * and that parameter is the whole of the legacy story:
 *
 *   - creating a detection label without a role is refused, so the distinction
 *     holds for everything new;
 *   - changing one that has none, without mentioning role, keeps none — editing an
 *     instruction must not turn into a modelling decision the caller was never
 *     asked to make;
 *   - passing a role, on create or update, stores it. Unlike `type`, it may be
 *     changed as often as the user changes their mind.
 *
 * A role on a derived label is refused rather than dropped, the same way a
 * reference list on a detection label is: it is a request the caller expects to
 * have an effect.
 */
export function checkRole(
  value: unknown,
  type: LabelType,
  existing: Label | undefined,
): DetectionRole | undefined {
  const given = normalise(value).toLowerCase();

  if (type !== "detection") {
    if (given) throw new LabelError(`role applies to detection labels, not to a ${type} label`);
    return undefined;
  }

  if (!given) {
    if (!existing) {
      throw new LabelError(
        "a detection label must say which role its fact plays: " +
          `${[...DETECTION_ROLES].sort().join(" or ")} — a category is what kind of email this ` +
          "is (Invoice, Delivery), an attribute is what the email contains, indicates or " +
          "requires (Action required, Deadline)",
      );
    }
    // Unmodelled stays unmodelled. Nothing here guesses.
    return existing.role;
  }

  if (!(DETECTION_ROLES as readonly string[]).includes(given)) {
    throw new LabelError(
      `unknown role "${given}" — roles: ${[...DETECTION_ROLES].sort().join(", ")}`,
    );
  }
  return given as DetectionRole;
}

/** Checks an instruction, which no type may leave empty. */
export function checkInstruction(value: unknown, type: LabelType): string {
  const instruction = String(value ?? "").trim();
  if (!instruction) {
    throw new LabelError(`instruction must not be empty for a ${type} label`);
  }
  return instruction;
}

/**
 * Rejects reference lists on a type that has none.
 *
 * A detection label with `required_labels` is not a detection label with a
 * harmless extra field — it is a request the caller expects to have an effect,
 * and silently dropping it would be the wrong kindness.
 */
export function checkReferencesAllowed(type: LabelType, given: Partial<Record<ReferenceField, unknown>>): void {
  if (type === "derived") return;
  for (const field of REFERENCE_FIELDS) {
    const value = given[field];
    if (Array.isArray(value) ? value.length > 0 : Boolean(value)) {
      throw new LabelError(`${field} applies to derived labels, not to a ${type} label`);
    }
  }
}

/** A label's type never changes; a new label is the way to change one. */
export function checkTypeUnchanged(existing: Label, wanted: LabelType): void {
  if (existing.type !== wanted) {
    throw new LabelError(
      `a label's type is immutable: "${existing.label}" is a ${existing.type} label and cannot ` +
        `become ${wanted} — create a new label instead`,
    );
  }
}

// --- shape -----------------------------------------------------------------

/**
 * A label with its fields in canonical order, and reference lists only where
 * they belong.
 *
 * The order is the one the product documents: label, type, role, attention,
 * instruction, then the references. It is what the MCP endpoint returns and what
 * the skills describe — a client and a reader should not see two orders for one
 * label.
 *
 * `role` sits beside `type` because it refines it, and is left out entirely rather
 * than sent as null when there is none: a derived label has no role to have, and a
 * detection label from before the distinction has not been given one yet. An absent
 * key says that; `null` would look like a decision.
 */
export function orderLabel(entry: Label): Label {
  const ordered: Label = {
    label: entry.label,
    type: entry.type,
    ...(entry.type === "detection" && entry.role ? { role: entry.role } : {}),
    attention: entry.attention,
    instruction: entry.instruction,
  };
  if (entry.type === "derived") {
    ordered.required_labels = entry.required_labels ?? [];
    ordered.recommended_labels = entry.recommended_labels ?? [];
  }
  return ordered;
}

/** Labels alphabetically, ignoring case: the order the store reads best in. */
export function byLabel(labels: readonly Label[]): Label[] {
  return [...labels].sort((a, b) =>
    a.label.toLowerCase() < b.label.toLowerCase() ? -1 : a.label.toLowerCase() > b.label.toLowerCase() ? 1 : 0,
  );
}

// --- messages the store needs ---------------------------------------------
//
// Built here rather than at the query, so that every complaint the product makes
// about a label is written in one place and worded the same way each time.

export function labelNotFound(label: string): LabelError {
  return new LabelError(`no label "${normalise(label)}" (use get_labels to see them)`);
}

export function labelExists(existing: string): LabelError {
  return new LabelError(
    `a label called "${existing}" already exists — labels are unique, ignoring case`,
  );
}

export function referenceMissing(field: ReferenceField, wanted: string, detection: readonly string[]): LabelError {
  return new LabelError(
    `${field} references "${wanted}", which is not an existing label — detection labels: ` +
      (detection.length ? detection.map((one) => `"${one}"`).join(", ") : "none yet"),
  );
}

export function referenceNotDetection(field: ReferenceField, target: Label): LabelError {
  return new LabelError(
    `${field} may only reference detection labels, and "${target.label}" is a ${target.type} label`,
  );
}

export function deleteBlocked(entry: Label, blocking: readonly Label[]): LabelError {
  const kinds = [...new Set(blocking.map((one) => one.type))].sort().join("/");
  return new LabelError(
    `cannot delete ${entry.type} label "${entry.label}": it is referenced by ${kinds} ` +
      `label${blocking.length === 1 ? "" : "s"} ` +
      `${blocking.map((one) => `"${one.label}"`).join(", ")} — remove the reference first`,
  );
}

export function deleteReserved(label: string): LabelError {
  const purpose = RESERVED_LABELS[normalise(label).toLowerCase()];
  return new LabelError(
    `"${normalise(label)}" is a reserved system label: ${gmailLabel(normalise(label).toLowerCase())} ` +
      `is ${purpose}, and is not stored as a label, so there is nothing to delete`,
  );
}

export function nothingToUpdate(): LabelError {
  return new LabelError(
    "nothing to update: pass a new label, type, role, attention, instruction, required_labels or recommended_labels",
  );
}
