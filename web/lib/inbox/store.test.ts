import assert from "node:assert/strict";
import test, { after, describe } from "node:test";

import type { SqlDriver } from "../db/driver.ts";
import { migrate } from "../db/migrate.ts";
import { embeddedDriver } from "../db/pglite.ts";
import { LabelError } from "./labels.ts";
import { INBOX_SCHEMA } from "./store/schema.ts";
import { sqlProductStore } from "./store/sql.ts";
import type { ProductStore } from "./store.ts";

/**
 * InboxLabeler's per-user state, driven the way the MCP tools drive it.
 *
 * The suite runs against the embedded Postgres always, and a real Postgres too
 * when `TEST_DATABASE_URL` is set — the same reason as the OAuth store: one run
 * proves the statements are right, the other proves they are right on a server
 * with real connections and real row locks.
 *
 * Two themes run through it. One is that a user's state is theirs: every read is
 * scoped, and the store takes no argument that could say otherwise. The other is
 * that the operations which touch more than one table cannot be caught halfway —
 * a rename carries the history, a delete takes it, a bad label records nothing.
 */

const ALICE = { id: "google:alice" };
const BOB = { id: "google:bob" };

const drivers: { name: string; open: () => Promise<SqlDriver> }[] = [
  { name: "embedded postgres", open: () => embeddedDriver() },
];

if (process.env.TEST_DATABASE_URL) {
  drivers.push({
    name: "postgres",
    open: async () => {
      const { postgresDriver } = await import("../db/postgres.ts");
      return postgresDriver(process.env.TEST_DATABASE_URL!);
    },
  });
}

/** The message a rejected operation came back with, or "accepted". */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "accepted";
  } catch (error) {
    if (error instanceof LabelError) return error.message;
    throw error;
  }
}

for (const driver of drivers) {
  describe(driver.name, () => {
    const opened: SqlDriver[] = [];

    /** Two stores on one database, so isolation is tested rather than assumed. */
    async function fresh(): Promise<{ alice: ProductStore; bob: ProductStore; sql: SqlDriver }> {
      const sql = await driver.open();
      opened.push(sql);
      await migrate(sql, INBOX_SCHEMA);
      await sql.exec(`
        TRUNCATE inbox_label_references, inbox_label_daily_matches,
                 inbox_label_match_state, inbox_labels;
      `);
      return { alice: sqlProductStore(sql, ALICE), bob: sqlProductStore(sql, BOB), sql };
    }

    after(async () => {
      for (const sql of opened) await sql.close().catch(() => {});
    });

    /**
     * A detection label, which most tests need one of.
     *
     * The role defaults to `category` because these labels stand in for "some
     * detection label" and any valid role will do; the tests that are *about* the
     * role pass their own.
     */
    const detection = (
      store: ProductStore,
      label: string,
      attention = "normal",
      role = "category",
    ) => store.createLabel({ label, instruction: `whether ${label} applies`, attention, role });

    // --- new users --------------------------------------------------------

    test("a new user starts with nothing, and is not seeded with examples", async () => {
      const { alice } = await fresh();

      assert.deepEqual(await alice.labels(), []);
      assert.deepEqual(await alice.matches(), {});
    });

    // --- isolation --------------------------------------------------------

    test("two users can use the same label name independently", async () => {
      const { alice, bob } = await fresh();

      await alice.createLabel({ label: "Invoices", instruction: "Alice's invoices", role: "category" });
      await bob.createLabel({ label: "Invoices", instruction: "Bob's invoices", role: "category" });

      assert.equal((await alice.label("Invoices")).instruction, "Alice's invoices");
      assert.equal((await bob.label("Invoices")).instruction, "Bob's invoices");
    });

    test("user A cannot see user B's labels", async () => {
      const { alice, bob } = await fresh();
      await detection(bob, "Bob only");

      assert.deepEqual(await alice.labels(), []);
      assert.match(await refusal(alice.label("Bob only")), /^no label "Bob only"/);
    });

    test("user A cannot see user B's matches", async () => {
      const { alice, bob } = await fresh();
      await detection(bob, "Invoices");
      await bob.recordMatches(["Invoices"], "2026-08-20T10:12:00Z");

      assert.deepEqual(await alice.matches(), {});

      // Alice having a label of the same name must not let her read Bob's counts.
      await detection(alice, "Invoices");
      assert.deepEqual(await alice.matchesFor("Invoices"), {
        Invoices: { last_matched_at: null, daily_matches: {} },
      });
    });

    test("deleting one user's label leaves the other's alone", async () => {
      const { alice, bob } = await fresh();
      await detection(alice, "Invoices");
      await detection(bob, "Invoices");

      await alice.deleteLabel("Invoices");

      assert.deepEqual(await alice.labels(), []);
      assert.equal((await bob.label("Invoices")).label, "Invoices");
    });

    test("one user's rename does not touch another's label of the same name", async () => {
      const { alice, bob } = await fresh();
      await detection(alice, "Invoices");
      await detection(bob, "Invoices");
      await bob.recordMatches(["Invoices"], "2026-08-20T10:12:00Z");

      await alice.updateLabel("Invoices", { label: "Bills" });

      assert.equal((await alice.label("Bills")).label, "Bills");
      assert.equal((await bob.label("Invoices")).label, "Invoices");
      assert.ok((await bob.matches()).Invoices, "Bob's history stayed where it was");
    });

    // --- creating ---------------------------------------------------------

    test("a created label carries the documented defaults", async () => {
      const { alice } = await fresh();
      const entry = await alice.createLabel({
        label: "Invoices",
        instruction: "an invoice",
        role: "category",
      });

      // The canonical order the product documents, role included and sitting
      // beside the type it refines.
      assert.deepEqual(entry, {
        label: "Invoices",
        type: "detection",
        role: "category",
        attention: "normal",
        instruction: "an invoice",
      });
    });

    test("a label's text is trimmed and its inner whitespace collapsed", async () => {
      const { alice } = await fresh();
      const entry = await alice.createLabel({ label: "  Large   amount ", instruction: "big", role: "category" });

      assert.equal(entry.label, "Large amount");
      assert.equal((await alice.label("large amount")).label, "Large amount", "found ignoring case");
    });

    test("labels are unique ignoring case", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      assert.match(
        await refusal(alice.createLabel({ label: "invoices", instruction: "again", role: "category" })),
        /already exists — labels are unique, ignoring case/,
      );
    });

    test("the label rules are the documented ones", async () => {
      const { alice } = await fresh();
      const create = (label: string) => alice.createLabel({ label, instruction: "x", role: "category" });

      assert.match(await refusal(create("")), /label must not be empty/);
      assert.match(await refusal(create("IL/Invoices")), /stored without the IL\/ prefix/);
      assert.match(await refusal(create("il/Invoices")), /stored without the IL\/ prefix/);
      assert.match(await refusal(create("/Invoices")), /must not start or end with '\/'/);
      assert.match(await refusal(create("Invoices/")), /must not start or end with '\/'/);
      assert.match(await refusal(create("a//b")), /contain '\/\/'/);
      assert.match(await refusal(create("processed")), /reserved system label/);
      assert.match(await refusal(create("NO-MATCH")), /reserved system label/);
      assert.match(
        await refusal(alice.createLabel({ label: "Empty", instruction: "  ", role: "category" })),
        /instruction must not be empty/,
      );
      assert.match(
        await refusal(alice.createLabel({ label: "Odd", instruction: "x", attention: "urgent", role: "category" })),
        /unknown attention "urgent"/,
      );
      assert.match(
        await refusal(alice.createLabel({ label: "Odd", instruction: "x", type: "guessed", role: "category" })),
        /unknown label type "guessed"/,
      );
    });

    test("reference lists are refused on a detection label", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      assert.match(
        await refusal(
          alice.createLabel({ label: "Odd", instruction: "x", required_labels: ["Invoices"], role: "category" }),
        ),
        /required_labels applies to derived labels, not to a detection label/,
      );
    });

    // --- derived labels ---------------------------------------------------

    test("a derived label names existing detection labels", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");
      await detection(alice, "Large amount");

      const derived = await alice.createLabel({
        label: "Large invoice",
        type: "derived",
        instruction: "a large invoice",
        attention: "high",
        required_labels: ["invoices", "Large amount"],
        recommended_labels: [],
      });

      assert.deepEqual(derived, {
        label: "Large invoice",
        type: "derived",
        attention: "high",
        instruction: "a large invoice",
        // Spelled the way the labels they point at are spelled, not the way they
        // were typed.
        required_labels: ["Invoices", "Large amount"],
        recommended_labels: [],
      });
    });

    test("a reference to a label that does not exist is refused", async () => {
      const { alice } = await fresh();

      assert.match(
        await refusal(
          alice.createLabel({
            label: "Derived",
            type: "derived",
            instruction: "x",
            required_labels: ["Nothing"],
          }),
        ),
        /required_labels references "Nothing", which is not an existing label/,
      );
    });

    test("a derived label may not reference another derived label", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");
      await alice.createLabel({
        label: "Large invoice",
        type: "derived",
        instruction: "x",
        required_labels: ["Invoices"],
      });

      assert.match(
        await refusal(
          alice.createLabel({
            label: "Chained",
            type: "derived",
            instruction: "x",
            required_labels: ["Large invoice"],
          }),
        ),
        /may only reference detection labels, and "Large invoice" is a derived label/,
      );
    });

    test("a reference named twice collapses to one", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");
      const derived = await alice.createLabel({
        label: "Derived",
        type: "derived",
        instruction: "x",
        required_labels: ["Invoices", "invoices"],
      });

      assert.deepEqual(derived.required_labels, ["Invoices"]);
    });

    // --- category and attribute -------------------------------------------
    //
    // A detection label says what kind of fact it found as well as that it found
    // one. The rule is asymmetric on purpose: required for anything new, optional
    // for a label that predates the distinction, and changeable for both — unlike
    // `type`, which is a different label rather than a revised opinion.

    test("a new detection label may be a category or an attribute", async () => {
      const { alice } = await fresh();

      const category = await alice.createLabel({
        label: "Invoice",
        instruction: "The message is an invoice.",
        role: "category",
      });
      const attribute = await alice.createLabel({
        label: "Large amount",
        instruction: "The message mentions a large sum.",
        role: "attribute",
      });

      assert.equal(category.role, "category");
      assert.equal(attribute.role, "attribute");
    });

    test("a new detection label without a role is refused, and the refusal says why", async () => {
      const { alice } = await fresh();

      const refused = await refusal(
        alice.createLabel({ label: "Invoice", instruction: "The message is an invoice." }),
      );
      assert.match(refused, /must say which role its fact plays/);
      assert.match(refused, /attribute or category/);
      // The message has to be usable by whoever hit it, so it says what each is.
      assert.match(refused, /what kind of email this is/);
      assert.match(refused, /contains, indicates or requires/);
    });

    test("a derived label has no role, and is refused one", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoice");
      await detection(alice, "Large amount", "normal", "attribute");

      const derived = await alice.createLabel({
        label: "Large invoice",
        type: "derived",
        instruction: "An invoice worth looking at.",
        required_labels: ["Invoice", "Large amount"],
      });
      assert.equal("role" in derived, false, "no role key at all, rather than an empty one");

      assert.match(
        await refusal(
          alice.createLabel({
            label: "Refused",
            type: "derived",
            instruction: "x",
            role: "category",
            required_labels: ["Invoice"],
          }),
        ),
        /role applies to detection labels, not to a derived label/,
      );
    });

    test("a role survives being written and read back", async () => {
      const { alice } = await fresh();
      await alice.createLabel({
        label: "Deadline",
        instruction: "The message states a cutoff.",
        role: "attribute",
      });

      // Read through a fresh query rather than from the create's return value:
      // the question is whether the column holds it, not whether the function
      // returned what it was given.
      assert.equal((await alice.label("deadline")).role, "attribute");
      assert.equal((await alice.labels())[0].role, "attribute");
    });

    test("a role can be changed from category to attribute and back", async () => {
      const { alice } = await fresh();
      await alice.createLabel({ label: "Marketing", instruction: "Promotion.", role: "category" });

      assert.equal((await alice.updateLabel("Marketing", { role: "attribute" })).role, "attribute");
      assert.equal((await alice.updateLabel("Marketing", { role: "category" })).role, "category");
    });

    test("a label from before roles existed is read, used and edited without one", async () => {
      const { alice, sql } = await fresh();

      // Exactly the row a pre-migration account holds: no role, because the column
      // did not exist when it was written. Inserted directly, because the API this
      // test exists to protect refuses to create one.
      await sql.query(
        `INSERT INTO inbox_labels (user_id, label, type, attention, instruction)
         VALUES ($1, $2, 'detection', 'normal', $3)`,
        [ALICE.id, "Legacy", "modelled before roles existed"],
      );

      const [legacy] = await alice.labels();
      assert.equal(legacy.label, "Legacy");
      assert.equal("role" in legacy, false, "absent, not null and not defaulted");

      // The thing this whole asymmetry exists for: editing something unrelated must
      // not turn into a modelling decision the caller was never asked to make.
      const edited = await alice.updateLabel("Legacy", { instruction: "still unmodelled" });
      assert.equal(edited.instruction, "still unmodelled");
      assert.equal("role" in edited, false, "the edit did not invent a role");

      // And it can still be referenced, so a derived label built on it keeps working.
      const derived = await alice.createLabel({
        label: "On top",
        type: "derived",
        instruction: "Interprets the legacy fact.",
        required_labels: ["Legacy"],
      });
      assert.deepEqual(derived.required_labels, ["Legacy"]);

      // Modelling it later is one explicit update.
      assert.equal((await alice.updateLabel("Legacy", { role: "category" })).role, "category");
    });

    // --- updating ---------------------------------------------------------

    test("an update with no changes is refused", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      assert.match(await refusal(alice.updateLabel("Invoices", {})), /nothing to update/);
    });

    test("a label's type is immutable", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      assert.match(
        await refusal(alice.updateLabel("Invoices", { type: "derived" })),
        /type is immutable/,
      );
    });

    test("editable fields are edited and the rest left alone", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      const updated = await alice.updateLabel("Invoices", {
        instruction: "an invoice, bill or receipt",
        attention: "high",
      });

      assert.equal(updated.instruction, "an invoice, bill or receipt");
      assert.equal(updated.attention, "high");
      assert.equal(updated.label, "Invoices");
    });

    test("renaming onto an existing label is refused", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");
      await detection(alice, "Bills");

      assert.match(await refusal(alice.updateLabel("Invoices", { label: "Bills" })), /already exists/);
    });

    test("a rename rewrites every reference to the label", async () => {
      const { alice } = await fresh();
      await detection(alice, "Large amount");
      await detection(alice, "Invoices");
      await alice.createLabel({
        label: "Large invoice",
        type: "derived",
        instruction: "x",
        required_labels: ["Invoices", "Large amount"],
        recommended_labels: ["Large amount"],
      });

      await alice.updateLabel("Large amount", { label: "Big amount" });

      const derived = await alice.label("Large invoice");
      assert.deepEqual(derived.required_labels, ["Invoices", "Big amount"]);
      assert.deepEqual(derived.recommended_labels, ["Big amount"]);
    });

    test("updating a derived label replaces its reference lists rather than adding", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");
      await detection(alice, "Large amount");
      await alice.createLabel({
        label: "Derived",
        type: "derived",
        instruction: "x",
        required_labels: ["Invoices", "Large amount"],
      });

      const updated = await alice.updateLabel("Derived", { required_labels: ["Invoices"] });
      assert.deepEqual(updated.required_labels, ["Invoices"]);

      const cleared = await alice.updateLabel("Derived", { required_labels: [] });
      assert.deepEqual(cleared.required_labels, []);
    });

    // --- rename and delete carry the history ------------------------------

    test("a rename carries the match history with it", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");
      await alice.recordMatches(["Invoices"], "2026-08-18T09:00:00Z");
      await alice.recordMatches(["Invoices"], "2026-08-20T10:12:00Z");

      await alice.updateLabel("Invoices", { label: "Bills" });

      const matches = await alice.matches();
      assert.equal(matches.Invoices, undefined, "nothing is left under the old name");
      assert.deepEqual(matches.Bills, {
        last_matched_at: "2026-08-20T10:12:00Z",
        daily_matches: { "2026-08-18": 1, "2026-08-20": 1 },
      });
    });

    test("no counter is lost to a rename, however many days it spans", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");
      for (const day of ["2026-08-01", "2026-08-02", "2026-08-03"]) {
        await alice.recordMatches(["Invoices"], `${day}T10:00:00Z`);
        await alice.recordMatches(["Invoices"], `${day}T11:00:00Z`);
      }

      const before = (await alice.matches()).Invoices;
      await alice.updateLabel("Invoices", { label: "Bills" });
      const after = (await alice.matches()).Bills;

      assert.deepEqual(after, before, "the history is the same history");
      assert.equal(
        Object.values(after.daily_matches).reduce((sum, n) => sum + n, 0),
        6,
      );
    });

    test("deleting a label removes its match history", async () => {
      const { alice, sql } = await fresh();
      await detection(alice, "Invoices");
      await alice.recordMatches(["Invoices"], "2026-08-20T10:12:00Z");

      await alice.deleteLabel("Invoices");

      assert.deepEqual(await alice.matches(), {});
      for (const table of ["inbox_label_daily_matches", "inbox_label_match_state"]) {
        const rows = await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        assert.equal(rows[0].n, 0, `${table} left nothing orphaned`);
      }
    });

    test("a referenced detection label cannot be deleted", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");
      await alice.createLabel({
        label: "Large invoice",
        type: "derived",
        instruction: "x",
        required_labels: ["Invoices"],
      });

      assert.match(
        await refusal(alice.deleteLabel("Invoices")),
        /cannot delete detection label "Invoices": it is referenced by derived label "Large invoice"/,
      );
      assert.ok(await alice.label("Invoices"), "and it is still there");
    });

    test("a reserved label cannot be deleted", async () => {
      const { alice } = await fresh();

      assert.match(await refusal(alice.deleteLabel("processed")), /reserved system label/);
    });

    // --- rollback ---------------------------------------------------------

    test("a failed rename leaves everything as it was", async () => {
      const { alice, sql } = await fresh();
      await detection(alice, "Invoices");
      await detection(alice, "Bills");
      await alice.recordMatches(["Invoices"], "2026-08-20T10:12:00Z");

      // Refused because "Bills" exists — after the transaction has already read
      // and begun to work.
      await refusal(alice.updateLabel("Invoices", { label: "Bills", attention: "high" }));

      const entry = await alice.label("Invoices");
      assert.equal(entry.attention, "normal", "the other change rolled back too");
      assert.ok((await alice.matches()).Invoices, "and the history is still under the old name");

      const rows = await sql.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM inbox_labels WHERE user_id = $1",
        [ALICE.id],
      );
      assert.equal(rows[0].n, 2);
    });

    test("a failed create leaves no half-built derived label", async () => {
      const { alice, sql } = await fresh();
      await detection(alice, "Invoices");

      await refusal(
        alice.createLabel({
          label: "Derived",
          type: "derived",
          instruction: "x",
          required_labels: ["Invoices", "Nothing"],
        }),
      );

      assert.equal(await refusal(alice.label("Derived")), 'no label "Derived" (use get_labels to see them)');
      const rows = await sql.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM inbox_label_references",
      );
      assert.equal(rows[0].n, 0, "no reference row survived");
    });

    // --- recording matches ------------------------------------------------

    test("recording a match counts it against the email's own UTC day", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      const recorded = await alice.recordMatches(["Invoices"], "2026-08-20T10:12:00Z");

      assert.equal(recorded.email_timestamp, "2026-08-20T10:12:00Z");
      assert.equal(recorded.day, "2026-08-20");
      assert.deepEqual(recorded.labels, {
        Invoices: { last_matched_at: "2026-08-20T10:12:00Z", daily_matches: { "2026-08-20": 1 } },
      });
    });

    test("an offset is converted to UTC before the day is decided", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      // 01:30 in +02:00 is the previous day in UTC, which is the day that counts.
      const recorded = await alice.recordMatches(["Invoices"], "2026-08-21T01:30:00+02:00");

      assert.equal(recorded.day, "2026-08-20");
      assert.equal(recorded.email_timestamp, "2026-08-20T23:30:00Z");
    });

    test("a timestamp without an offset is refused, because the day would be a guess", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      assert.match(
        await refusal(alice.recordMatches(["Invoices"], "2026-08-20T10:12:00")),
        /has no UTC offset, so the day it counts towards would be a guess/,
      );
      assert.match(
        await refusal(alice.recordMatches(["Invoices"], "2026-08-20")),
        /is not an ISO 8601 timestamp/,
      );
      assert.match(
        await refusal(alice.recordMatches(["Invoices"], "not a date")),
        /is not an ISO 8601 timestamp/,
      );
    });

    test("recording an unknown label is refused", async () => {
      const { alice } = await fresh();

      assert.match(
        await refusal(alice.recordMatches(["Nothing"], "2026-08-20T10:12:00Z")),
        /^no label "Nothing"/,
      );
      assert.match(await refusal(alice.recordMatches([], "2026-08-20T10:12:00Z")), /no labels given/);
    });

    test("the same label twice for one email is refused", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      assert.match(
        await refusal(alice.recordMatches(["Invoices", "invoices"], "2026-08-20T10:12:00Z")),
        /was given twice for the same email/,
      );
    });

    test("multiple labels for one email are all recorded, atomically", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");
      await detection(alice, "Large amount");
      await alice.createLabel({
        label: "Large invoice",
        type: "derived",
        instruction: "x",
        required_labels: ["Invoices", "Large amount"],
      });

      const recorded = await alice.recordMatches(
        ["Invoices", "Large amount", "Large invoice"],
        "2026-08-20T10:12:00Z",
      );

      assert.deepEqual(Object.keys(recorded.labels), ["Invoices", "Large amount", "Large invoice"]);
      for (const history of Object.values(recorded.labels)) {
        assert.deepEqual(history.daily_matches, { "2026-08-20": 1 });
      }
    });

    test("if one label is invalid, none of the others is recorded", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");
      await detection(alice, "Large amount");

      await refusal(
        alice.recordMatches(["Invoices", "Large amount", "Nothing"], "2026-08-20T10:12:00Z"),
      );

      assert.deepEqual(await alice.matches(), {}, "nothing was recorded at all");
    });

    test("repeated matches on one day add up, and a new day is its own count", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      await alice.recordMatches(["Invoices"], "2026-08-20T09:00:00Z");
      await alice.recordMatches(["Invoices"], "2026-08-20T10:00:00Z");
      await alice.recordMatches(["Invoices"], "2026-08-21T10:00:00Z");

      assert.deepEqual((await alice.matches()).Invoices, {
        last_matched_at: "2026-08-21T10:00:00Z",
        daily_matches: { "2026-08-20": 2, "2026-08-21": 1 },
      });
    });

    test("the same email reported twice counts twice: there is no deduplication", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      await alice.recordMatches(["Invoices"], "2026-08-20T10:12:00Z");
      await alice.recordMatches(["Invoices"], "2026-08-20T10:12:00Z");

      assert.deepEqual((await alice.matches()).Invoices.daily_matches, { "2026-08-20": 2 });
    });

    test("an older email raises its own day but never moves last_matched_at backwards", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      await alice.recordMatches(["Invoices"], "2026-08-20T10:12:00Z");
      await alice.recordMatches(["Invoices"], "2026-06-01T08:00:00Z");

      assert.deepEqual((await alice.matches()).Invoices, {
        last_matched_at: "2026-08-20T10:12:00Z",
        daily_matches: { "2026-06-01": 1, "2026-08-20": 1 },
      });
    });

    test("a newer email does move it forward", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      await alice.recordMatches(["Invoices"], "2026-08-20T10:12:00Z");
      await alice.recordMatches(["Invoices"], "2026-08-22T07:00:00Z");

      assert.equal((await alice.matches()).Invoices.last_matched_at, "2026-08-22T07:00:00Z");
    });

    test("a label with no history reads as never matched, not as missing", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      assert.deepEqual(await alice.matchesFor("Invoices"), {
        Invoices: { last_matched_at: null, daily_matches: {} },
      });
      assert.deepEqual(await alice.matches(), {}, "and it is absent from the whole history");
    });

    test("asking for the history of a label that does not exist is refused", async () => {
      const { alice } = await fresh();

      assert.match(await refusal(alice.matchesFor("Nothing")), /^no label "Nothing"/);
    });

    // --- concurrency ------------------------------------------------------

    test("simultaneous recordings of one label and day lose no counts", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      await Promise.all(
        Array.from({ length: 20 }, () => alice.recordMatches(["Invoices"], "2026-08-20T10:12:00Z")),
      );

      assert.deepEqual((await alice.matches()).Invoices.daily_matches, { "2026-08-20": 20 });
    });

    test("simultaneous recordings across labels and days lose no counts", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");
      await detection(alice, "Large amount");

      await Promise.all([
        ...Array.from({ length: 10 }, () =>
          alice.recordMatches(["Invoices", "Large amount"], "2026-08-20T10:00:00Z"),
        ),
        ...Array.from({ length: 5 }, () => alice.recordMatches(["Invoices"], "2026-08-21T10:00:00Z")),
      ]);

      const matches = await alice.matches();
      assert.deepEqual(matches.Invoices.daily_matches, { "2026-08-20": 10, "2026-08-21": 5 });
      assert.deepEqual(matches["Large amount"].daily_matches, { "2026-08-20": 10 });
    });

    test("simultaneous recordings settle last_matched_at on the newest", async () => {
      const { alice } = await fresh();
      await detection(alice, "Invoices");

      const stamps = [
        "2026-08-18T10:00:00Z",
        "2026-08-22T10:00:00Z",
        "2026-08-19T10:00:00Z",
        "2026-08-21T10:00:00Z",
      ];
      await Promise.all(stamps.map((at) => alice.recordMatches(["Invoices"], at)));

      assert.equal((await alice.matches()).Invoices.last_matched_at, "2026-08-22T10:00:00Z");
    });

    test("two users recording at once do not touch each other's counts", async () => {
      const { alice, bob } = await fresh();
      await detection(alice, "Invoices");
      await detection(bob, "Invoices");

      await Promise.all([
        ...Array.from({ length: 8 }, () => alice.recordMatches(["Invoices"], "2026-08-20T10:00:00Z")),
        ...Array.from({ length: 3 }, () => bob.recordMatches(["Invoices"], "2026-08-20T10:00:00Z")),
      ]);

      assert.deepEqual((await alice.matches()).Invoices.daily_matches, { "2026-08-20": 8 });
      assert.deepEqual((await bob.matches()).Invoices.daily_matches, { "2026-08-20": 3 });
    });

    // --- privacy ----------------------------------------------------------

    test("the match tables have nowhere to put anything about an email", async () => {
      const { sql } = await fresh();

      const columns = async (table: string) =>
        (
          await sql.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_name = $1 ORDER BY column_name`,
            [table],
          )
        ).map((row) => row.column_name);

      assert.deepEqual(await columns("inbox_label_daily_matches"), [
        "count",
        "day",
        "label",
        "user_id",
      ]);
      assert.deepEqual(await columns("inbox_label_match_state"), [
        "label",
        "last_matched_at",
        "user_id",
      ]);
    });

    test("no table in the product schema could hold an email or identify one", async () => {
      const { sql } = await fresh();

      const rows = await sql.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_name LIKE 'inbox_%'`,
      );
      const forbidden =
        /subject|sender|from|to|recipient|cc|bcc|body|snippet|message|thread|attach|gmail|mime|header/i;

      for (const row of rows) {
        assert.equal(
          forbidden.test(row.column_name),
          false,
          `${row.table_name}.${row.column_name} looks like email data`,
        );
      }
      // And no per-email table at all: four tables, none of them an event log.
      const tables = [...new Set(rows.map((row) => row.table_name))].sort();
      assert.deepEqual(tables, [
        "inbox_label_daily_matches",
        "inbox_label_match_state",
        "inbox_label_references",
        "inbox_labels",
      ]);
    });

    // --- which handle names which label ----------------------------------
    //
    // The database decides that, in `lower()`, and these tests hold the store to
    // the same answer. `İ` is the case they turn on: Postgres lowercases it to
    // `i`, JavaScript to `i` followed by a combining dot, so a store that folded
    // case itself would fail to find a label the database can see. Each test
    // first asks this database what it thinks, so the premise is checked rather
    // than assumed — a build whose Postgres disagrees skips rather than lies.

    const DOTTED = "\u0130stanbul";

    /** Whether this database reads the two spellings as one label. */
    async function readsAsOne(sql: SqlDriver, one: string, other: string): Promise<boolean> {
      const [row] = await sql.query<{ same: boolean }>(
        "SELECT lower($1::text) = lower($2::text) AS same",
        [one, other],
      );
      return row.same;
    }

    test("the database and JavaScript really do fold this case differently", async () => {
      const { sql } = await fresh();

      assert.equal(await readsAsOne(sql, DOTTED, "istanbul"), true, "Postgres reads them as one");
      assert.notEqual(DOTTED.toLowerCase(), "istanbul", "JavaScript does not");
    });

    test("a label is found by any spelling the database reads as its own", async () => {
      const { alice, sql } = await fresh();
      if (!(await readsAsOne(sql, DOTTED, "istanbul"))) return;
      await detection(alice, DOTTED);

      assert.equal((await alice.label("istanbul")).label, DOTTED);
      assert.equal((await alice.label("ISTANBUL")).label, DOTTED);
    });

    test("an update reaches the label the database says was meant", async () => {
      const { alice, sql } = await fresh();
      if (!(await readsAsOne(sql, DOTTED, "istanbul"))) return;
      await detection(alice, DOTTED);

      const updated = await alice.updateLabel("istanbul", { instruction: "reached it" });

      assert.equal(updated.label, DOTTED, "the stored spelling is untouched");
      assert.equal(updated.instruction, "reached it");
      assert.deepEqual((await alice.labels()).map((one) => one.label), [DOTTED]);
    });

    test("a delete reaches the label the database says was meant", async () => {
      const { alice, sql } = await fresh();
      if (!(await readsAsOne(sql, DOTTED, "istanbul"))) return;
      await detection(alice, DOTTED);

      assert.equal((await alice.deleteLabel("ISTANBUL")).label, DOTTED);
      assert.deepEqual(await alice.labels(), []);
    });

    test("a delete is still refused while a reference remains, whatever the spelling", async () => {
      const { alice, sql } = await fresh();
      if (!(await readsAsOne(sql, DOTTED, "istanbul"))) return;
      await detection(alice, DOTTED);
      await alice.createLabel({
        label: "Trips",
        type: "derived",
        instruction: "a trip",
        required_labels: [DOTTED],
      });

      assert.match(await refusal(alice.deleteLabel("istanbul")), /it is referenced by derived label/);
    });

    test("a reference resolves to the stored spelling, not the one that was typed", async () => {
      const { alice, sql } = await fresh();
      if (!(await readsAsOne(sql, DOTTED, "istanbul"))) return;
      await detection(alice, DOTTED);

      const derived = await alice.createLabel({
        label: "Trips",
        type: "derived",
        instruction: "a trip",
        required_labels: ["istanbul"],
      });

      assert.deepEqual(derived.required_labels, [DOTTED]);
    });

    test("two spellings of one label make one reference, not two", async () => {
      const { alice, sql } = await fresh();
      if (!(await readsAsOne(sql, DOTTED, "istanbul"))) return;
      await detection(alice, DOTTED);

      const derived = await alice.createLabel({
        label: "Trips",
        type: "derived",
        instruction: "a trip",
        required_labels: [DOTTED, "istanbul", "ISTANBUL"],
      });

      assert.deepEqual(derived.required_labels, [DOTTED]);
    });

    test("one email naming a label twice is refused however it is spelled", async () => {
      const { alice, sql } = await fresh();
      if (!(await readsAsOne(sql, DOTTED, "istanbul"))) return;
      await detection(alice, DOTTED);

      assert.match(
        await refusal(alice.recordMatches([DOTTED, "istanbul"], "2026-08-20T10:12:00Z")),
        /was given twice for the same email/,
      );
    });

    test("a match records against the stored spelling, not the one that was typed", async () => {
      const { alice, sql } = await fresh();
      if (!(await readsAsOne(sql, DOTTED, "istanbul"))) return;
      await detection(alice, DOTTED);

      await alice.recordMatches(["istanbul"], "2026-08-20T10:12:00Z");

      assert.deepEqual(Object.keys(await alice.matches()), [DOTTED]);
      assert.deepEqual(Object.keys(await alice.matchesFor("ISTANBUL")), [DOTTED]);
    });

    test("the overview groups a message under the label the database recognises", async () => {
      const { alice, sql } = await fresh();
      if (!(await readsAsOne(sql, DOTTED, "istanbul"))) return;
      await detection(alice, DOTTED);

      // Gmail hands back its own spelling of the label on the message.
      const [overview] = await alice.representativeLabels([["IL/istanbul"]]);

      assert.equal(overview.representative, DOTTED);
      assert.deepEqual(overview.unknown, []);
    });

    test("two labels the store keeps apart never share one history", async () => {
      const { alice, sql } = await fresh();

      // The store keeps these apart — their lowercased forms differ — while
      // JavaScript folds both to the same string. A rarity lookup that folded
      // would hand one of them the other's matches.
      const apart = "\u0130stanbul";
      const folds = "i\u0307stanbul";
      const [premise] = await sql.query<{ apart: boolean }>(
        "SELECT lower($1::text) <> lower($2::text) AS apart",
        [apart, folds],
      );
      if (!premise.apart) return;
      assert.equal(apart.toLowerCase(), folds.toLowerCase(), "JavaScript folds them together");

      await detection(alice, apart);
      await detection(alice, folds);
      await detection(alice, "Zephyr");

      // The label JavaScript would collide with is the busiest; the one it would
      // collide *into* has never matched at all, and so is the rarest thing here.
      for (let n = 0; n < 5; n += 1) {
        await alice.recordMatches([apart], "2026-08-20T10:12:00Z");
      }
      await alice.recordMatches(["Zephyr"], "2026-08-20T10:12:00Z");

      const [overview] = await alice.representativeLabels([[folds, "Zephyr"]]);

      // Rarest wins: the label with no history. Borrowing the busy label's five
      // matches would have made Zephyr the rarer of the two, and the heading.
      assert.equal(overview.representative, folds);
      assert.deepEqual(overview.secondary, ["Zephyr"]);
    });

    test("a reference is not satisfied by a different label that folds like it", async () => {
      const { alice, sql } = await fresh();
      const apart = "\u0130stanbul";
      const folds = "i\u0307stanbul";
      const [premise] = await sql.query<{ apart: boolean }>(
        "SELECT lower($1::text) <> lower($2::text) AS apart",
        [apart, folds],
      );
      if (!premise.apart) return;
      assert.equal(apart.toLowerCase(), folds.toLowerCase(), "JavaScript folds them together");

      await detection(alice, apart);
      await detection(alice, folds);
      // One derived label refers to the label that is NOT on the message; the
      // other refers to the one that is. Only the second has a reference present.
      await alice.createLabel({
        label: "Aaa refers elsewhere",
        type: "derived",
        instruction: "x",
        required_labels: [apart],
      });
      await alice.createLabel({
        label: "Zzz refers here",
        type: "derived",
        instruction: "y",
        required_labels: [folds],
      });

      const [overview] = await alice.representativeLabels([
        [folds, "Aaa refers elsewhere", "Zzz refers here"],
      ]);

      // More references present wins. Counting the absent one as present would
      // level them, and the alphabet would then hand the heading to the other.
      assert.equal(overview.representative, "Zzz refers here");
    });

    test("a message carrying two labels that fold alike keeps both", async () => {
      const { alice, sql } = await fresh();
      const apart = "\u0130stanbul";
      const folds = "i\u0307stanbul";
      const [premise] = await sql.query<{ apart: boolean }>(
        "SELECT lower($1::text) <> lower($2::text) AS apart",
        [apart, folds],
      );
      if (!premise.apart) return;
      assert.equal(apart.toLowerCase(), folds.toLowerCase(), "JavaScript folds them together");

      await detection(alice, apart);
      await detection(alice, folds);

      const [overview] = await alice.representativeLabels([[apart, folds]]);

      assert.equal(overview.secondary.length, 1, "neither label was swallowed by the other");
      assert.deepEqual(
        [overview.representative, ...overview.secondary].sort(),
        [apart, folds].sort(),
      );
    });

    test("two labels the reading order cannot separate still order the same way twice", async () => {
      const { alice, sql } = await fresh();
      // The precomposed dotted capital and the letters it decomposes to: the
      // store keeps them apart, and a reader's alphabet has no opinion between
      // them, so the order has to come from somewhere that always answers.
      const composed = "\u0130zmir";
      const decomposed = "I\u0307zmir";
      const [premise] = await sql.query<{ apart: boolean }>(
        "SELECT lower($1::text) <> lower($2::text) AS apart",
        [composed, decomposed],
      );
      if (!premise.apart) return;
      assert.equal(composed.localeCompare(decomposed), 0, "the alphabet cannot separate them");
      assert.equal(composed.toLowerCase(), decomposed.toLowerCase(), "nor can case folding");

      await detection(alice, composed);
      await detection(alice, decomposed);

      const [forwards] = await alice.representativeLabels([[composed, decomposed]]);
      const [backwards] = await alice.representativeLabels([[decomposed, composed]]);

      assert.equal(backwards.representative, forwards.representative);
      assert.deepEqual(backwards.secondary, forwards.secondary);
    });

    test("a spelling never reaches another tenant's label of that name", async () => {
      const { alice, bob, sql } = await fresh();
      if (!(await readsAsOne(sql, DOTTED, "istanbul"))) return;
      await detection(bob, DOTTED);

      assert.match(await refusal(alice.label("istanbul")), /no label "istanbul"/);
      assert.match(await refusal(alice.updateLabel("istanbul", { instruction: "x" })), /no label/);
      assert.match(await refusal(alice.deleteLabel(DOTTED)), /no label/);
      assert.deepEqual((await bob.labels()).map((one) => one.label), [DOTTED]);
    });

    test("a day with no matches is absent rather than stored as zero", async () => {
      const { alice, sql } = await fresh();
      await detection(alice, "Invoices");
      await alice.recordMatches(["Invoices"], "2026-08-20T10:12:00Z");

      const rows = await sql.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM inbox_label_daily_matches WHERE count = 0",
      );
      assert.equal(rows[0].n, 0);
      assert.deepEqual(Object.keys((await alice.matches()).Invoices.daily_matches), ["2026-08-20"]);
    });
  });
}
