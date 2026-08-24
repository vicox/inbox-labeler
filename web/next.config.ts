import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The embedded Postgres the OAuth and product stores fall back to in
   * development is a WebAssembly build of a whole database. Next.js would
   * otherwise inline it — some thirty megabytes — into the server bundle for
   * every route that touches a store, so it is left external: a plain runtime
   * import that production never reaches, because production sets DATABASE_URL.
   *
   * `pg`, the driver production does use, is already on Next.js' own list of
   * packages excluded from bundling and needs no entry here.
   */
  serverExternalPackages: ["@electric-sql/pglite"],

  /**
   * Keeping it out of the *bundle* is not the same as keeping it out of the
   * deployment. Output file tracing follows the dynamic import that loads it and
   * copies the package into every serverless function that could reach a store —
   * measured at 21 MB of a 24 MB function, for a code path production cannot
   * take. Excluding it makes the functions a tenth of the size, which is cold
   * start time on every request that has to pay it.
   *
   * Safe because the branch that imports it is unreachable in production:
   * `lib/db.ts` raises a configuration error when `DATABASE_URL` is unset rather
   * than falling back, so a deployment either has Postgres or serves no requests
   * at all. Local `next start` is unaffected — tracing decides what gets copied
   * to a deployment, not what a local process can resolve.
   */
  outputFileTracingExcludes: {
    "/**": ["./node_modules/@electric-sql/pglite/**"],
  },
};

export default nextConfig;
