import { isSqlState, UNIQUE_VIOLATION, type SqlDriver, type Transaction } from "../../db/driver.ts";
import type { AuthenticatedUser } from "../../identity.ts";
import {
  byLabel,
  checkAttention,
  checkRole,
  checkInstruction,
  checkLabelText,
  checkReferencesAllowed,
  checkType,
  checkTypeUnchanged,
  deleteBlocked,
  deleteReserved,
  labelExists,
  labelNotFound,
  nothingToUpdate,
  normalise,
  orderLabel,
  referenceMissing,
  referenceNotDetection,
  RESERVED_LABELS,
  sameLabel,
  stripNamespace,
  type Label,
  type LabelType,
  type ReferenceField,
} from "../labels.ts";
import {
  checkRecordedLabels,
  dayOf,
  duplicateLabel,
  formatTimestamp,
  noHistory,
  orderMatches,
  parseEmailTimestamp,
  type Matches,
} from "../matches.ts";
import { overviewOf } from "../overview.ts";
import type { LabelDraft, ProductStore, Recorded } from "../store.ts";
import { INBOX_SCHEMA } from "./schema.ts";

export { INBOX_SCHEMA };

/**
 * InboxLabeler's state in SQL, for one user.
 *
 * `user` is closed over, and every statement below names it. There is no code
 * path that reads a row without `user_id = $1`, and no method that takes a user
 * — which is what makes cross-tenant access a thing you would have to add rather
 * than a thing you have to remember not to do.
 *
 * Anything that changes more than one row runs in a transaction, and the ones
 * that matter lean on the schema instead of doing the work themselves: a rename
 * is one `UPDATE` that cascades to the history and the references, a delete is
 * one `DELETE` that cascades to the history and is refused while a reference
 * remains. See `schema.ts` for why the label text being the key is what makes
 * that possible.
 */
export function sqlProductStore(driver: SqlDriver, user: AuthenticatedUser): ProductStore {
  const owner = user.id;

  return {
    async labels() {
      return readLabels(driver, owner);
    },

    async label(label) {
      const canonical = await resolveLabel(driver, owner, label);
      const found = canonical
        ? (await readLabels(driver, owner)).find((one) => one.label === canonical)
        : undefined;
      if (!found) throw labelNotFound(label);
      return found;
    },

    async createLabel(draft) {
      return driver.transaction(async (tx) => {
        const existing = await readLabels(tx, owner);
        const entry = await validate(tx, owner, existing, draft, undefined);

        try {
          await tx.query(
            `INSERT INTO inbox_labels (user_id, label, type, role, attention, instruction)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [owner, entry.label, entry.type, entry.role ?? null, entry.attention, entry.instruction],
          );
        } catch (error) {
          // The unique index is the real arbiter of identity, so a collision that
          // slipped past the read above — two creates racing — is caught here and
          // reported the same way.
          if (isSqlState(error, UNIQUE_VIOLATION)) throw labelExists(entry.label);
          throw error;
        }

        await writeReferences(tx, owner, entry);
        return entry;
      });
    },

    async updateLabel(label, changes) {
      if (Object.values(changes).every((value) => value === undefined)) throw nothingToUpdate();

      return driver.transaction(async (tx) => {
        const existing = await readLabels(tx, owner);
        const canonical = await resolveLabel(tx, owner, label);
        const current = canonical ? existing.find((one) => one.label === canonical) : undefined;
        if (!current) throw labelNotFound(label);

        const merged: LabelDraft = {
          label: changes.label ?? current.label,
          instruction: changes.instruction ?? current.instruction,
          type: changes.type ?? current.type,
          // Not defaulted to `current.role`: `checkRole` needs to see that the
          // caller said nothing, so it can leave an unmodelled label unmodelled
          // instead of treating silence as a decision.
          role: changes.role,
          attention: changes.attention ?? current.attention,
          required_labels: changes.required_labels ?? current.required_labels,
          recommended_labels: changes.recommended_labels ?? current.recommended_labels,
        };
        const entry = await validate(tx, owner, existing, merged, current);

        // One statement, and the schema carries the rest: the foreign keys are
        // ON UPDATE CASCADE, so the daily counts, the last-matched timestamp and
        // every reference pointing at this label follow the new text inside this
        // same statement. Nothing observes a label under one name and its history
        // under another, because there is no moment between.
        try {
          await tx.query(
            `UPDATE inbox_labels
                SET label = $3, role = $4, attention = $5, instruction = $6, updated_at = now()
              WHERE user_id = $1 AND label = $2`,
            [
              owner,
              current.label,
              entry.label,
              entry.role ?? null,
              entry.attention,
              entry.instruction,
            ],
          );
        } catch (error) {
          if (isSqlState(error, UNIQUE_VIOLATION)) throw labelExists(entry.label);
          throw error;
        }

        // Reference lists are replaced rather than merged: passing one says what it
        // should now be, and passing an empty one clears it.
        await tx.query(`DELETE FROM inbox_label_references WHERE user_id = $1 AND label = $2`, [
          owner,
          entry.label,
        ]);
        await writeReferences(tx, owner, entry);
        return entry;
      });
    },

    async deleteLabel(label) {
      for (const reserved of Object.keys(RESERVED_LABELS)) {
        if (sameLabel(label, reserved)) throw deleteReserved(label);
      }

      return driver.transaction(async (tx) => {
        const existing = await readLabels(tx, owner);
        const canonical = await resolveLabel(tx, owner, label);
        const entry = canonical ? existing.find((one) => one.label === canonical) : undefined;
        if (!entry) throw labelNotFound(label);

        // Asked before deleting so the refusal can name what is in the way. The
        // ON DELETE RESTRICT on the references table is the backstop that makes
        // the rule true even if this check were ever skipped.
        // Both sides are stored text here — a reference target is the exact
        // spelling of the label it points at, which the foreign key guarantees —
        // so they compare exactly rather than by any notion of sameness.
        const blocking = existing.filter((other) =>
          other.label !== entry.label &&
          [...(other.required_labels ?? []), ...(other.recommended_labels ?? [])].some(
            (ref) => ref === entry.label,
          ),
        );
        if (blocking.length) throw deleteBlocked(entry, blocking);

        // The history goes with it: both match tables cascade on delete, so
        // there is no orphaned count and no second statement to forget.
        await tx.query(`DELETE FROM inbox_labels WHERE user_id = $1 AND label = $2`, [
          owner,
          entry.label,
        ]);
        return entry;
      });
    },

    async matches() {
      return readMatches(driver, owner);
    },

    async representativeLabels(emails) {
      // Both reads, then one pure function over them. The ranking needs the whole
      // model and the whole history — a per-email query would ask the database
      // the same two questions once per message — and it needs no transaction,
      // because it writes nothing and a label appearing or disappearing mid-batch
      // would change one email's answer rather than corrupt anything.
      const [labels, matches] = await Promise.all([
        readLabels(driver, owner),
        readMatches(driver, owner),
      ]);
      return overviewOf(await storedSpellings(driver, owner, emails), labels, matches, new Date());
    },

    async matchesFor(label) {
      const canonical = await resolveLabel(driver, owner, label);
      if (!canonical) throw labelNotFound(label);

      const all = await readMatches(driver, owner);
      return orderMatches({ [canonical]: all[canonical] ?? noHistory() });
    },

    async recordMatches(labels, emailTimestamp) {
      const named = checkRecordedLabels(labels);
      const moment = parseEmailTimestamp(emailTimestamp);
      const day = dayOf(moment);

      return driver.transaction(async (tx) => {
        // Resolving first does two things: it refuses a label this user does not
        // have, and it gives the spelling the label is stored under, so the counts
        // are keyed the way the labels are even when the caller wrote a different case.
        // Doing it inside the transaction is what makes one bad label mean
        // nothing is recorded — the rollback takes the earlier increments with it.
        const found = await resolveLabels(tx, owner, named);
        const resolved: string[] = [];
        for (const [index, text] of named.entries()) {
          const canonical = found[index];
          if (!canonical) throw labelNotFound(text);
          // Two spellings the database reads as one label resolve to one stored
          // name, so naming it twice is caught here however it was spelled.
          if (resolved.includes(canonical)) throw duplicateLabel(canonical);
          resolved.push(canonical);
        }

        for (const label of resolved) {
          // An upsert, not a read followed by a write. Two requests recording the
          // same label and day at the same time both increment, because the
          // addition happens inside the statement where the row is locked —
          // application-side counting would lose one of them.
          await tx.query(
            `INSERT INTO inbox_label_daily_matches (user_id, label, day, count)
             VALUES ($1, $2, $3, 1)
             ON CONFLICT (user_id, label, day)
             DO UPDATE SET count = inbox_label_daily_matches.count + 1`,
            [owner, label, day],
          );

          // GREATEST is what keeps this field honest: a backfilled email raises
          // its own day's count but must never drag the newest-seen timestamp
          // backwards. Deciding that in SQL means two concurrent records cannot
          // read the same previous value and both win.
          await tx.query(
            `INSERT INTO inbox_label_match_state (user_id, label, last_matched_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, label)
             DO UPDATE SET last_matched_at =
               GREATEST(inbox_label_match_state.last_matched_at, EXCLUDED.last_matched_at)`,
            [owner, label, moment],
          );
        }

        const after = await readMatches(tx, owner, resolved);
        return {
          email_timestamp: formatTimestamp(moment),
          day,
          labels: after,
        } satisfies Recorded;
      });
    },
  };
}

// --- resolving a handle ----------------------------------------------------
//
// A label's text is its handle, and which handle names which label is a
// question the database answers: `inbox_labels_identity` is `lower(label)`, so
// `lower()` is the rule, and it is asked rather than reproduced. Folding case in
// JavaScript instead would be a second opinion — the two disagree on real
// Unicode, and a label that exists would then fail to be found by a spelling
// Postgres considers the same.
//
// Whitespace is not case: `normalise` collapses it here because that is the
// product's own rule about what a caller may have typed, and stored labels were
// normalised the same way on the way in.

/**
 * The stored labels these supplied spellings name, one entry per input, in
 * order, `undefined` where this user has no such label.
 *
 * One statement rather than one per name: a derived label with five references
 * resolves in a single round trip, and every row is scoped by `user_id` in the
 * join, so a spelling can never reach another tenant's label of the same name.
 */
async function resolveLabels(
  sql: Transaction,
  owner: string,
  supplied: readonly string[],
): Promise<(string | undefined)[]> {
  if (!supplied.length) return [];

  const rows = await sql.query<{ label: string | null }>(
    `SELECT stored.label
       FROM unnest($2::text[]) WITH ORDINALITY AS given(text, position)
       LEFT JOIN inbox_labels AS stored
         ON stored.user_id = $1 AND lower(stored.label) = lower(given.text)
      ORDER BY given.position`,
    [owner, supplied.map((text) => normalise(text))],
  );
  return rows.map((row) => row.label ?? undefined);
}

/** The stored label one supplied spelling names, or undefined. */
async function resolveLabel(
  sql: Transaction,
  owner: string,
  supplied: string,
): Promise<string | undefined> {
  const [found] = await resolveLabels(sql, owner, [supplied]);
  return found;
}

/**
 * The labels on each message, in the spelling this account stores them under.
 *
 * Gmail hands back the label text Gmail holds, which need not be the spelling
 * the label is stored with, so the database is asked which of its labels each
 * one names. A name it does not recognise is passed through untouched: the
 * overview reports it as a label this account no longer defines, and it should
 * say what is actually on the mail.
 *
 * Only the spellings change. Which labels are on which message, and everything
 * the ranking then does with them, is untouched.
 */
async function storedSpellings(
  sql: Transaction,
  owner: string,
  emails: readonly (readonly string[])[],
): Promise<string[][]> {
  const handle = (text: string) => normalise(stripNamespace(normalise(text)));

  const supplied = [...new Set(emails.flat().map(handle))].filter(Boolean);
  const found = await resolveLabels(sql, owner, supplied);
  const stored = new Map(supplied.map((text, index) => [text, found[index]]));

  return emails.map((given) => given.map((text) => stored.get(handle(text)) ?? text));
}

// --- reading ---------------------------------------------------------------

type LabelRow = {
  label: string;
  type: LabelType;
  role: string | null;
  attention: string;
  instruction: string;
};
type ReferenceRow = { label: string; kind: "required" | "recommended"; target: string };

/**
 * Every label this user has, with its reference lists filled in.
 *
 * Two queries rather than a join, because a join would repeat each label once per
 * reference and the assembly is clearer than the de-duplication. Both are scoped
 * by `user_id`, which is the only scoping there is.
 */
async function readLabels(sql: Transaction, owner: string): Promise<Label[]> {
  const rows = await sql.query<LabelRow>(
    `SELECT label, type, role, attention, instruction FROM inbox_labels WHERE user_id = $1`,
    [owner],
  );
  const references = await sql.query<ReferenceRow>(
    `SELECT label, kind, target FROM inbox_label_references
      WHERE user_id = $1 ORDER BY label, kind, position`,
    [owner],
  );

  const labels = rows.map((row) => {
    const entry: Label = {
      label: row.label,
      type: row.type,
      // A null role is a detection label nobody has modelled yet, which reads back
      // as an absent field rather than as an error or a default.
      ...(row.role ? { role: checkRole(row.role, row.type, undefined) } : {}),
      attention: checkAttention(row.attention),
      instruction: row.instruction,
    };
    if (row.type === "derived") {
      entry.required_labels = [];
      entry.recommended_labels = [];
    }
    return entry;
  });

  const byName = new Map(labels.map((entry) => [entry.label, entry]));
  for (const row of references) {
    const entry = byName.get(row.label);
    if (!entry) continue;
    const field: ReferenceField = row.kind === "required" ? "required_labels" : "recommended_labels";
    (entry[field] ??= []).push(row.target);
  }

  return byLabel(labels).map(orderLabel);
}

/**
 * The match history, keyed by label text.
 *
 * A label with no counts and no timestamp is simply absent rather than present and
 * zero — which is why this reads the two match tables rather than
 * every label. `only` narrows it to the labels just recorded.
 */
async function readMatches(sql: Transaction, owner: string, only?: readonly string[]): Promise<Matches> {
  const narrowing = only ? " AND label = ANY($2)" : "";
  const params = only ? [owner, only] : [owner];

  const counts = await sql.query<{ label: string; day: string; count: number }>(
    `SELECT label, to_char(day, 'YYYY-MM-DD') AS day, count
       FROM inbox_label_daily_matches WHERE user_id = $1${narrowing} ORDER BY label, day`,
    params,
  );
  const state = await sql.query<{ label: string; last_matched_at: Date }>(
    `SELECT label, last_matched_at FROM inbox_label_match_state WHERE user_id = $1${narrowing}`,
    params,
  );

  const matches: Matches = {};
  const entry = (label: string) => (matches[label] ??= noHistory());
  for (const row of counts) entry(row.label).daily_matches[row.day] = Number(row.count);
  for (const row of state) entry(row.label).last_matched_at = formatTimestamp(row.last_matched_at);

  return orderMatches(matches);
}

// --- writing ---------------------------------------------------------------

/**
 * Validates a complete label against what this user already has.
 *
 * The rules that need only the value live in `labels.ts`; the ones here are the
 * ones that need to know what else exists — uniqueness, and that every reference
 * names an existing detection label. `own` is the label being updated, excluded
 * from both so a label does not collide with or reference itself.
 */
async function validate(
  sql: Transaction,
  owner: string,
  existing: readonly Label[],
  draft: LabelDraft,
  own: Label | undefined,
): Promise<Label> {
  const type = checkType(draft.type);
  if (own) checkTypeUnchanged(own, type);

  const label = checkLabelText(draft.label);
  const attention = checkAttention(draft.attention);
  const instruction = checkInstruction(draft.instruction, type);
  checkReferencesAllowed(type, draft);

  // Last of the value checks, so a caller who got something more fundamental wrong
  // hears about that instead: an empty instruction is a plainer problem than an
  // unstated role, and being told the plainer one first is more use. `own` is
  // undefined on a create, which is what makes the role required there and optional
  // on an update.
  const role = checkRole(draft.role, type, own);

  // The unique index is what actually decides this, and it decides it in
  // `lower()`, so the question is put to the database rather than answered
  // beside it. Asking early is only for the message: a collision that races past
  // this is caught by the index itself, and reported the same way.
  const clash = await resolveLabel(sql, owner, label);
  if (clash && (!own || clash !== own.label)) throw labelExists(clash);

  const entry: Label = { label, type, attention, instruction };
  if (role) entry.role = role;
  if (type === "derived") {
    entry.required_labels = await resolveReferences(
      sql,
      owner,
      existing,
      own,
      draft.required_labels,
      "required_labels",
    );
    entry.recommended_labels = await resolveReferences(
      sql,
      owner,
      existing,
      own,
      draft.recommended_labels,
      "recommended_labels",
    );
  }
  return orderLabel(entry);
}

/**
 * Resolves a reference list to the spellings its targets use.
 *
 * Every entry must name an existing detection label. Duplicates collapse, so
 * naming one twice is a list of one rather than a complaint — the reference is a
 * set, and the caller's intent is unambiguous either way.
 */
async function resolveReferences(
  sql: Transaction,
  owner: string,
  existing: readonly Label[],
  own: Label | undefined,
  values: unknown,
  field: ReferenceField,
): Promise<string[]> {
  const wanted = (Array.isArray(values) ? values : [])
    .map((value) => normalise(value))
    .filter(Boolean);
  const found = await resolveLabels(sql, owner, wanted);

  const resolved: string[] = [];
  for (const [index, name] of wanted.entries()) {
    // A label may not reference itself. On an update it is in the table under
    // its current name, so the query does find it — excluded here rather than in
    // the query, which would have to be told what is being updated.
    const canonical = found[index] === own?.label ? undefined : found[index];
    const target = canonical ? existing.find((other) => other.label === canonical) : undefined;
    if (!target) {
      const detection = existing
        .filter((other) => (!own || other.label !== own.label) && other.type === "detection")
        .map((other) => other.label);
      throw referenceMissing(field, name, detection);
    }
    if (target.type !== "detection") throw referenceNotDetection(field, target);
    // Two spellings the database reads as one label resolved to one stored name,
    // so this collapses them without a second opinion about what "same" means.
    if (!resolved.includes(target.label)) resolved.push(target.label);
  }
  return resolved;
}

/** Writes a derived label's reference rows, in the order they were given. */
async function writeReferences(sql: Transaction, owner: string, entry: Label): Promise<void> {
  if (entry.type !== "derived") return;

  const rows: [ReferenceField, "required" | "recommended"][] = [
    ["required_labels", "required"],
    ["recommended_labels", "recommended"],
  ];
  for (const [field, kind] of rows) {
    const targets = entry[field] ?? [];
    for (const [position, target] of targets.entries()) {
      await sql.query(
        `INSERT INTO inbox_label_references (user_id, label, kind, target, position)
         VALUES ($1, $2, $3, $4, $5)`,
        [owner, entry.label, kind, target, position],
      );
    }
  }
}
