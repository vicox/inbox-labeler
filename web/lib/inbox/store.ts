import { database } from "../db.ts";
import type { SqlDriver } from "../db/driver.ts";
import { prepareSchema } from "../db/migrate.ts";
import type { AuthenticatedUser } from "../identity.ts";
import type { Attention, DetectionRole, Label, LabelType, ReferenceField } from "./labels.ts";
import type { Matches } from "./matches.ts";
import type { EmailOverview } from "./overview.ts";

/**
 * One user's InboxLabeler state, and every operation on it.
 *
 * The user is not a parameter of anything below. It is fixed when the store is
 * opened and captured for the life of it, so there is no argument a caller could
 * get wrong and no field an MCP client could supply: `inboxStore(user)` is the
 * only way to reach any of this, and the only user it can reach is the one it
 * was given. That is the whole isolation mechanism, and it is a shape rather
 * than a check — a tool cannot ask for someone else's labels because there is
 * nowhere to say whose labels it wants.
 *
 * The operations are the product's, not the database's. There is no `insert`
 * here and no `where`: `createLabel` and `recordMatches` are things InboxLabeler
 * does, and what SQL they take is the adapter's business. That is what keeps SQL
 * out of the MCP tools.
 */

/** What `create_label` is given. Absent optional fields take their defaults. */
export type LabelDraft = {
  label: unknown;
  instruction: unknown;
  type?: unknown;
  /** Detection labels only, and required for a new one: `category` or `attribute`. */
  role?: unknown;
  attention?: unknown;
  required_labels?: unknown;
  recommended_labels?: unknown;
};

/**
 * What `update_label` may change.
 *
 * Every field is optional and `undefined` means "leave it alone", which is why
 * this is not simply a partial label: passing an empty reference list clears it,
 * and that has to be distinguishable from not mentioning it.
 */
export type LabelChanges = {
  label?: unknown;
  instruction?: unknown;
  type?: unknown;
  /**
   * Detection labels only. Unlike `type`, a role may be changed — `category` and
   * `attribute` are a modelling judgement the user is allowed to revise. Absent
   * leaves it alone, which is what lets a label from before the distinction be
   * edited without being forced to declare one.
   */
  role?: unknown;
  attention?: unknown;
  required_labels?: unknown;
  recommended_labels?: unknown;
};

/** What `record_matches` reports back: the day it counted, and the histories. */
export type Recorded = {
  email_timestamp: string;
  day: string;
  labels: Matches;
};

export type ProductStore = {
  /** Every label this user has defined, alphabetically. Empty for a new user. */
  labels(): Promise<Label[]>;
  /** One label, by its text, matched case-insensitively. Throws if unknown. */
  label(label: string): Promise<Label>;

  createLabel(draft: LabelDraft): Promise<Label>;
  /** Applies changes, renaming and rewriting references when the text changes. */
  updateLabel(label: string, changes: LabelChanges): Promise<Label>;
  /** Removes a label and its history together. Refused if anything references it. */
  deleteLabel(label: string): Promise<Label>;

  /** Every label that has ever matched. A label with no history is absent. */
  matches(): Promise<Matches>;
  /** One label's history, or an empty one if it has never matched. */
  matchesFor(label: string): Promise<Matches>;

  /**
   * Records one match per named label, all from the same email.
   *
   * `emailTimestamp` is the email's own, never the moment this runs: processing
   * an old message during a backfill must raise that old day's count, which is
   * what makes the history usable.
   */
  recordMatches(labels: readonly string[], emailTimestamp: unknown): Promise<Recorded>;

  /**
   * Which one label represents each of these already-processed emails.
   *
   * One entry in, one entry out, in the same order. Each entry is the business
   * labels a processing run already put on one message; nothing about the
   * message itself is passed, and nothing is written. `lib/inbox/overview.ts`
   * holds the rule, and it ranks against the model as it stands now — this reads
   * the labels and the history it needs.
   */
  representativeLabels(emails: readonly (readonly string[])[]): Promise<EmailOverview[]>;
};

/** Re-exported so a caller needs one import to work with what these return. */
export type { Attention, DetectionRole, Label, LabelType, ReferenceField, Matches, EmailOverview };

/**
 * Opens the store for one authenticated user.
 *
 * Takes the `AuthenticatedUser` rather than an id string, so that reaching this
 * function at all means having been through the OAuth boundary. A bare string
 * could be anything a request body contained; this type only exists on the far
 * side of a verified token.
 *
 * A new user has no state and none is created for them: a first `get_labels`
 * returns an empty list rather than fifteen labels somebody else chose. The
 * starter set lives in `skills/inbox-labeler-setup`, and arrives only when
 * somebody asks for it.
 */
export async function inboxStore(user: AuthenticatedUser): Promise<ProductStore> {
  const driver = await prepared();
  const { sqlProductStore } = await import("./store/sql.ts");
  return sqlProductStore(driver, user);
}

/**
 * The connection, with this schema known to be current — done once per process.
 *
 * A store is opened per request, and migrating on each one would spend several
 * round trips re-establishing something that cannot have changed since the last
 * request. Caching the promise rather than a flag means concurrent first requests
 * wait for one run instead of starting several.
 *
 * Running it at all is belt and braces: a deploy should run `npm run db:migrate`
 * in its own step, and an instance that comes up against an un-migrated database
 * should still work rather than serve errors until someone notices.
 *
 * A failure is forgotten rather than cached, so an instance that could not reach
 * the database on its first request is not broken for the rest of its life.
 */
let preparing: Promise<SqlDriver> | undefined;

function prepared(): Promise<SqlDriver> {
  preparing ??= (async () => {
    const driver = await database();
    const { INBOX_SCHEMA } = await import("./store/schema.ts");
    await prepareSchema(driver, INBOX_SCHEMA);
    return driver;
  })().catch((error: unknown) => {
    preparing = undefined;
    throw error;
  });
  return preparing;
}
