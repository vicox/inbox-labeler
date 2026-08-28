/**
 * Who operates this deployment, for the pages that are legally required to say.
 *
 * The values are configuration rather than source, for one reason: they are a
 * private individual's name and home address. A repository is public, cloned and
 * mirrored; an environment variable is entered once in the host's dashboard and
 * appears in no diff. The legal *texts* stay in source, because they are the
 * operator's statements and belong under review like any other change — only the
 * identity behind them is configured.
 *
 * ## An incomplete configuration yields no page, not a page with gaps
 *
 * `§ 5 DDG` and Art. 13 GDPR require a real name and an address at which the
 * operator can be served. A page missing either is not a lesser disclosure, it is
 * a false one: it looks like the required statement while naming nobody. So the
 * pages that depend on these values answer `404` when they are unset, which is
 * the honest answer — the disclosure does not exist yet — and it is impossible
 * for a placeholder, an empty line or the word "undefined" to reach a reader.
 */

export type Operator = {
  readonly name: string;
  /** The postal address, one element per line, as an address is written. */
  readonly addressLines: readonly string[];
  readonly email: string;
};

/** The variables that have to be set, and what each one holds. */
const REQUIRED = [
  "LEGAL_NAME",
  "LEGAL_ADDRESS_LINE_1",
  "LEGAL_ADDRESS_LINE_2",
  "LEGAL_CONTACT_EMAIL",
] as const;

/**
 * The configured operator, or null when anything required is missing.
 *
 * Null rather than a thrown error, so a caller decides what to do about it —
 * here that is `notFound()`, and a build without the variables set still
 * succeeds instead of failing on a page that is not the point of the build.
 *
 * Read per call rather than at module scope: a value read while a module is
 * first imported is frozen for the life of the process, which is the wrong
 * behaviour for something an operator sets in a dashboard.
 */
export function operator(): Operator | null {
  const values = REQUIRED.map((name) => process.env[name]?.trim() ?? "");
  if (values.some((value) => !value)) return null;

  const [name, line1, line2, email] = values;
  return {
    name,
    // The country is stated rather than configured: these pages are written for
    // a German operator throughout — they cite German statutes and one of them
    // is in German — so a deployment that needed a different country would need
    // different texts, not a fifth variable.
    addressLines: [line1, line2, "Germany"],
    email,
  };
}

/** The date the legal pages last changed in substance. */
export const LEGAL_UPDATED = "28 August 2026";
