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

  /**
   * The pages that can carry one person's data, told to no cache anywhere.
   *
   * `dynamic = "force-dynamic"` already stops Next.js from caching these, and that
   * is not the same promise: what a page needs is that nothing *between* the
   * function and the browser keeps a copy either. A CDN, a corporate proxy or a
   * shared browser cache holding one person's labels and handing them to the next
   * request for the same URL is the whole failure, and `private, no-store` is how a
   * response says so to all three.
   *
   * `/` is on this list because it is now both pages: a landing page for a stranger
   * and this user's labels for whoever is signed in. Two answers at one URL is
   * exactly the shape a shared cache gets wrong.
   *
   * Declared here rather than in the page because a Server Component cannot set a
   * response header — and because a rule about which URLs are private belongs
   * somewhere it can be read in one place.
   */
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "cache-control", value: "private, no-store, max-age=0, must-revalidate" },
          // Deliberately *not* noindex: this is the public landing page, and a
          // crawler is never signed in, so what it can reach is the half that is
          // meant to be found.
          { key: "x-frame-options", value: "DENY" },
          // A sign-out is a POST to this origin; a referrer leaving for another
          // site has no reason to carry the path somebody was signed in at.
          { key: "referrer-policy", value: "same-origin" },
        ],
      },
      {
        // The sign-in endpoints answer redirects and refusals mid-flow. None of it
        // may sit in a cache to be handed to the next caller.
        source: "/auth/:path*",
        headers: [{ key: "cache-control", value: "private, no-store, max-age=0, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
