/**
 * What a label is, and every rule about one that does not need a database.
 *
 * This is `skills/inbox-labeler/labels.py` expressed in TypeScript, and that
 * file is the reference: the local CLI and the hosted MCP endpoint are two ways
 * into one product, so a label that the CLI accepts must be a label the endpoint
 * accepts, spelled and rejected the same way. Where a rule could be written
 * either as prose or as a shared mechanism, it is written twice on purpose —
 * a build step bridging Python and TypeScript for six field names would cost
 * more than it saves — and `labels.parity.test.ts` reads the Python source to
 * check the vocabulary has not drifted.
 *
 * The field names are snake_case because they are `labels.json`'s field names,
 * not this language's. `lib/policy.ts` describes the same file for the web UI's
 * own reading of it; the two agree because they are both descriptions of that
 * one document.
 */

/** The Gmail namespace InboxLabeler owns. Labels are stored without it. */
export const GMAIL_NAMESPACE = "IL/";

/**
 * What a label asks of the user, lowest priority first.
 *
 * The order is the priority aggregation follows: `normal` is the absence of a
 * request, so any label that does ask for something outranks it, and `high`
 * outranks `none`. Nothing in this file aggregates — the local `attention`
 * command does — but the order is part of the vocabulary and is checked against
 * the Python source.
 */
export const ATTENTION_LEVELS = ["normal", "none", "high"] as const;
export type Attention = (typeof ATTENTION_LEVELS)[number];
export const DEFAULT_ATTENTION: Attention = "normal";

/** How a label decides whether it applies. */
export const LABEL_TYPES = ["detection", "derived"] as const;
export type LabelType = (typeof LABEL_TYPES)[number];
export const DEFAULT_TYPE: LabelType = "detection";

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

/** A label, exactly as `labels.json` holds one. */
export type Label = {
  label: string;
  type: LabelType;
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
 * ours. The messages deliberately echo the CLI's, because someone moving between
 * the two should not have to learn a second vocabulary of complaints.
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
 * The order is `labels.json`'s: label, type, attention, instruction, then the
 * references. It is what the file looks like, so it is what the MCP endpoint
 * returns — a client reading both should not see two orders for one document.
 */
export function orderLabel(entry: Label): Label {
  const ordered: Label = {
    label: entry.label,
    type: entry.type,
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
// about a label is written in one file and can be read against labels.py.

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
    "nothing to update: pass a new label, type, attention, instruction, required_labels or recommended_labels",
  );
}
