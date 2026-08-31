import type { SchemaModule } from "../../db/migrate.ts";

/**
 * InboxLabeler's own state in Postgres: the policy, and what happened to it.
 *
 * Four tables, and two halves: the labels the user defines, and what happened to
 * them. They stay apart for a reason — nothing about a count
 * belongs in a label definition, and a label with no history should have no
 * history rather than a row full of nulls.
 *
 * One column is deliberately nullable: `inbox_labels.role`, which says whether a
 * detection label's fact is a category or an attribute. It arrived after accounts
 * had labels in them, and a null there means "nobody has decided yet" rather than
 * a default — see migration 2.
 *
 * ## Why the label text is the key
 *
 * A label's text is its only identifier, in the files and here. There is no
 * surrogate id, because introducing one would invent an identity the product does
 * not have and would let the policy and its history disagree about which label is
 * which. Instead every child table names `(user_id, label)` and carries a foreign
 * key with `ON UPDATE CASCADE`, which is what makes the two hard operations fall
 * out of the schema rather than out of application code:
 *
 *     rename   UPDATE inbox_labels SET label = 'Bills' …
 *                → cascades to daily counts, last-matched state and every
 *                  reference pointing at it, in one statement, atomically
 *
 *     delete   DELETE FROM inbox_labels …
 *                → cascades to the history, so none is orphaned;
 *                  and is REFUSED while another label references it
 *
 * There is no window in which the policy is under one name and its counts under
 * another, because there is no second statement to be interrupted between.
 *
 * ## Privacy is a schema property here
 *
 * `inbox_label_daily_matches` has room for a label, a day and a number, and
 * `inbox_label_match_state` for one timestamp. There is nowhere to put a subject,
 * a sender, a recipient, a message id, a thread id, an attachment or a body, and
 * no table with one row per email. That is deliberate and load-bearing: the store
 * can answer "how often does this label fire" and is structurally unable to
 * answer anything about a message.
 */
export const INBOX_SCHEMA: SchemaModule = {
  module: "inbox",
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE inbox_labels (
          user_id     text NOT NULL,
          label       text NOT NULL,
          type        text NOT NULL,
          attention   text NOT NULL,
          instruction text NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now(),
          updated_at  timestamptz NOT NULL DEFAULT now(),

          PRIMARY KEY (user_id, label),

          -- The vocabulary, kept honest by the database as well as by the code
          -- that writes it. A value outside these sets means a bug, not input.
          CONSTRAINT inbox_labels_type CHECK (type IN ('detection', 'derived')),
          CONSTRAINT inbox_labels_attention CHECK (attention IN ('none', 'normal', 'high')),
          -- No type may leave the instruction empty.
          CONSTRAINT inbox_labels_instruction CHECK (btrim(instruction) <> ''),
          -- The text rules that survive being written down: never empty, never
          -- carrying the Gmail namespace the store adds on the way out.
          CONSTRAINT inbox_labels_label CHECK (btrim(label) <> '' AND label NOT ILIKE 'IL/%')
        );

        -- Labels are unique per user ignoring case, which the primary key alone
        -- does not say: "Invoices" and "invoices" are one label, so this is the
        -- constraint that actually carries identity. Two users may of course
        -- both have an "Invoices" — user_id leads every key here.
        CREATE UNIQUE INDEX inbox_labels_identity
          ON inbox_labels (user_id, lower(label));

        -- A derived label's references, one row each, ordered so the lists come
        -- back the way they were given.
        CREATE TABLE inbox_label_references (
          user_id    text NOT NULL,
          label      text NOT NULL,
          kind       text NOT NULL,
          target     text NOT NULL,
          position   integer NOT NULL,

          PRIMARY KEY (user_id, label, kind, target),
          CONSTRAINT inbox_label_references_kind CHECK (kind IN ('required', 'recommended')),

          -- Renaming the derived label carries its references with it.
          CONSTRAINT inbox_label_references_owner
            FOREIGN KEY (user_id, label) REFERENCES inbox_labels (user_id, label)
            ON UPDATE CASCADE ON DELETE CASCADE,

          -- Renaming the referenced label rewrites every reference to it, and
          -- deleting one is refused while a reference remains. The skills state both
          -- rules in prose; here they are the schema, so neither can be forgotten.
          CONSTRAINT inbox_label_references_target
            FOREIGN KEY (user_id, target) REFERENCES inbox_labels (user_id, label)
            ON UPDATE CASCADE ON DELETE RESTRICT,

          -- A label referencing itself is not a relationship.
          CONSTRAINT inbox_label_references_not_self CHECK (label <> target)
        );

        -- Answering "which derived labels point at this one" without a scan,
        -- which is what a delete has to ask before it is allowed to proceed.
        CREATE INDEX inbox_label_references_target_index
          ON inbox_label_references (user_id, target);

        -- How often a label matched, per UTC calendar day. One row per label per
        -- day — never per email.
        CREATE TABLE inbox_label_daily_matches (
          user_id text NOT NULL,
          label   text NOT NULL,
          day     date NOT NULL,
          count   integer NOT NULL,

          PRIMARY KEY (user_id, label, day),
          -- A day with no matches is absent, not zero. The counter only ever
          -- increments, so a row at zero would mean something had gone wrong.
          CONSTRAINT inbox_label_daily_matches_count CHECK (count > 0),
          CONSTRAINT inbox_label_daily_matches_label
            FOREIGN KEY (user_id, label) REFERENCES inbox_labels (user_id, label)
            ON UPDATE CASCADE ON DELETE CASCADE
        );

        -- The newest email timestamp a label has matched. Separate from the daily
        -- counts because it cannot be derived from them: they keep the day, and
        -- this keeps the moment. A label that has never matched has no row.
        CREATE TABLE inbox_label_match_state (
          user_id         text NOT NULL,
          label           text NOT NULL,
          last_matched_at timestamptz NOT NULL,

          PRIMARY KEY (user_id, label),
          CONSTRAINT inbox_label_match_state_label
            FOREIGN KEY (user_id, label) REFERENCES inbox_labels (user_id, label)
            ON UPDATE CASCADE ON DELETE CASCADE
        );
      `,
    },
    {
      // Category or attribute, for detection labels.
      //
      // Nullable, and that is the migration: an account that predates the
      // distinction keeps working, its labels read and match exactly as before, and
      // nothing here guesses which role each of them plays. Only new detection
      // labels are required to say, which is a rule the code enforces on create —
      // the column cannot express "required from now on".
      //
      // What the database does carry is that the value is one of two, and that a
      // derived label never has one at all. Backfilling is a modelling
      // conversation with the user, not a statement.
      version: 2,
      sql: `
        ALTER TABLE inbox_labels ADD COLUMN role text;

        ALTER TABLE inbox_labels
          ADD CONSTRAINT inbox_labels_role
          CHECK (role IS NULL OR role IN ('category', 'attribute'));

        -- A derived label is already an interpretation of detection facts, so there
        -- is no kind-of-fact for it to be. Enforced here as well as in the code,
        -- because it is an invariant about the row rather than about a request.
        ALTER TABLE inbox_labels
          ADD CONSTRAINT inbox_labels_role_detection_only
          CHECK (type = 'detection' OR role IS NULL);
      `,
    },
  ],
};
