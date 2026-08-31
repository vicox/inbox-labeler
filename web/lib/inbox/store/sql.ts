import { isSqlState, UNIQUE_VIOLATION, type SqlDriver, type Transaction } from "../../db/driver.ts";
import type { AuthenticatedUser } from "../../identity.ts";
import {
  byLabel,
  checkAttention,
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
      const found = (await readLabels(driver, owner)).find((one) => sameLabel(one.label, label));
      if (!found) throw labelNotFound(label);
      return found;
    },

    async createLabel(draft) {
      return driver.transaction(async (tx) => {
        const existing = await readLabels(tx, owner);
        const entry = await validate(tx, owner, existing, draft, undefined);

        try {
          await tx.query(
            `INSERT INTO inbox_labels (user_id, label, type, attention, instruction)
             VALUES ($1, $2, $3, $4, $5)`,
            [owner, entry.label, entry.type, entry.attention, entry.instruction],
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
        const current = existing.find((one) => sameLabel(one.label, label));
        if (!current) throw labelNotFound(label);

        const merged: LabelDraft = {
          label: changes.label ?? current.label,
          instruction: changes.instruction ?? current.instruction,
          type: changes.type ?? current.type,
          attention: changes.attention ?? current.attention,
          required_labels: changes.required_labels ?? current.required_labels,
          recommended_labels: changes.recommended_labels ?? current.recommended_labels,
        };
        const entry = await validate(tx, owner, existing, merged, current);

        // One statement, and the schema carries the rest: the foreign keys are
        // ON UPDATE CASCADE, so the daily counts, the last-matched timestamp and
        // every reference pointing at this label follow the new text inside this
        // same statement. Nothing observes the policy under one name and its
        // history under another, because there is no moment between.
        try {
          await tx.query(
            `UPDATE inbox_labels
                SET label = $3, attention = $4, instruction = $5, updated_at = now()
              WHERE user_id = $1 AND label = $2`,
            [owner, current.label, entry.label, entry.attention, entry.instruction],
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
        const entry = existing.find((one) => sameLabel(one.label, label));
        if (!entry) throw labelNotFound(label);

        // Asked before deleting so the refusal can name what is in the way. The
        // ON DELETE RESTRICT on the references table is the backstop that makes
        // the rule true even if this check were ever skipped.
        const blocking = existing.filter((other) =>
          other.label !== entry.label &&
          [...(other.required_labels ?? []), ...(other.recommended_labels ?? [])].some((ref) =>
            sameLabel(ref, entry.label),
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

    async matchesFor(label) {
      const found = (await readLabels(driver, owner)).find((one) => sameLabel(one.label, label));
      if (!found) throw labelNotFound(label);

      const all = await readMatches(driver, owner);
      return orderMatches({ [found.label]: all[found.label] ?? noHistory() });
    },

    async recordMatches(labels, emailTimestamp) {
      const named = checkRecordedLabels(labels);
      const moment = parseEmailTimestamp(emailTimestamp);
      const day = dayOf(moment);

      return driver.transaction(async (tx) => {
        // Resolving first does two things: it refuses a label this user does not
        // have, and it gives the spelling the policy uses, so the counts are keyed
        // the way the policy is even when the caller wrote a different case.
        // Doing it inside the transaction is what makes one bad label mean
        // nothing is recorded — the rollback takes the earlier increments with it.
        const existing = await readLabels(tx, owner);
        const resolved: string[] = [];
        for (const text of named) {
          const found = existing.find((one) => sameLabel(one.label, text));
          if (!found) throw labelNotFound(text);
          if (resolved.some((already) => sameLabel(already, found.label))) {
            throw duplicateLabel(found.label);
          }
          resolved.push(found.label);
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

// --- reading ---------------------------------------------------------------

type LabelRow = { label: string; type: LabelType; attention: string; instruction: string };
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
    `SELECT label, type, attention, instruction FROM inbox_labels WHERE user_id = $1`,
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

  const clash = existing.find(
    (other) => (!own || other.label !== own.label) && sameLabel(other.label, label),
  );
  if (clash) throw labelExists(clash.label);

  const entry: Label = { label, type, attention, instruction };
  if (type === "derived") {
    entry.required_labels = resolveReferences(existing, own, draft.required_labels, "required_labels");
    entry.recommended_labels = resolveReferences(
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
function resolveReferences(
  existing: readonly Label[],
  own: Label | undefined,
  values: unknown,
  field: ReferenceField,
): string[] {
  const resolved: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const wanted = normalise(value);
    if (!wanted) continue;

    const target = existing.find(
      (other) => (!own || other.label !== own.label) && sameLabel(other.label, wanted),
    );
    if (!target) {
      const detection = existing
        .filter((other) => (!own || other.label !== own.label) && other.type === "detection")
        .map((other) => other.label);
      throw referenceMissing(field, wanted, detection);
    }
    if (target.type !== "detection") throw referenceNotDetection(field, target);
    if (!resolved.some((already) => sameLabel(already, target.label))) resolved.push(target.label);
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
