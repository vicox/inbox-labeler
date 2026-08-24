/**
 * The little any store here needs from a database.
 *
 * Deliberately smaller than any real client's API, so that adding an adapter is
 * a day's work rather than a port and nothing above it can reach for a
 * driver-specific feature.
 *
 * `query` and `exec` are separate because the wire protocol separates them.
 * `query` carries bound parameters, which makes it a prepared statement and
 * therefore exactly one command — every value a store handles goes through it,
 * always bound and never interpolated. `exec` runs a multi-statement script with
 * no parameters, which is what a migration is; putting DDL through `query`
 * fails, and putting a parameter through `exec` is impossible, so the split
 * keeps both honest.
 */
export type SqlDriver = {
  query<Row>(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Runs a parameterless script, which may contain several statements. */
  exec(sql: string): Promise<void>;
  /** Runs `work` in a transaction, rolling back if it throws. */
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** What a transaction body may do: the same two calls, on one connection. */
export type Transaction = Pick<SqlDriver, "query" | "exec">;

/** Postgres' unique-violation SQLSTATE, which several callers here key on. */
export const UNIQUE_VIOLATION = "23505";

/** Postgres' foreign-key-violation SQLSTATE. */
export const FOREIGN_KEY_VIOLATION = "23503";

/** Postgres' check-constraint SQLSTATE. */
export const CHECK_VIOLATION = "23514";

/** Whether a thrown value is the Postgres error with this SQLSTATE. */
export function isSqlState(error: unknown, code: string): boolean {
  return (error as { code?: string } | null)?.code === code;
}
