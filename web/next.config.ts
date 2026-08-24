import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The embedded Postgres the OAuth store falls back to in development is a
   * WebAssembly build of a whole database, and Next.js would otherwise inline it
   * — some thirty megabytes of it — into the server bundle for every route that
   * touches the store. Leaving it external keeps it out of the build entirely
   * and makes it a plain runtime import, which is what lets it stay a
   * development dependency: production sets DATABASE_URL, never reaches the
   * branch that loads it, and does not need it installed.
   *
   * `pg`, the driver production does use, is already on Next.js' own list of
   * packages excluded from bundling and needs no entry here.
   */
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
