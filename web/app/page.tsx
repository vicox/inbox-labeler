import { AccountHeader, LabelList, Notice } from "@/components/labels";
import { LegalLinks } from "@/components/legal";
import { PolicyGraph } from "@/components/policy-graph";
import type { Label } from "@/lib/inbox/labels";
import { inboxStore } from "@/lib/inbox/store";
import { currentVisitor, type SignedInVisitor } from "@/lib/web/visitor";

/**
 * One address, two pages: the landing page for anyone, and this user's labels for
 * whoever is signed in.
 *
 * There is no separate app URL, and that is the point. A signed-in person who
 * types the product's name into a browser wants their labels, not a page about the
 * product with a link to their labels on it — and a second surface showing the
 * same rows is a second place for the two to disagree about what they say and who
 * may read them.
 *
 * ## Where the owner comes from
 *
 * From the session cookie, through `currentVisitor`, and from nowhere else. This
 * page reads no route parameter, no search parameter and no request body, and
 * `inboxStore` takes the resolved user rather than an id — so there is no
 * expression here in which a value from the request could decide whose labels are
 * read. The store then scopes every statement to that user; see
 * `lib/inbox/store.ts`.
 *
 * ## What happens when the answer is no
 *
 * Not signed in, an unknown or expired session, a tampered cookie and an account
 * the access list no longer admits all land on the landing page, where the only
 * thing offered is signing in. They are not distinguished, because to the person in
 * front of the browser they mean the same thing, and because saying which would
 * report whether a guessed cookie had found a live session.
 */

/**
 * Never prerendered and never cached. This page reads a session cookie and, for a
 * signed-in visitor, one user's rows; a cached answer would be one person's labels
 * handed to the next. The response headers that say so to every cache in between
 * are in `next.config.ts`, because a Server Component cannot set one.
 *
 * What is given up is a prerendered shell for the landing half. That half is a
 * heading and a client component that fetches its own content, so there was little
 * to prerender, and a visitor with no session cookie is still answered without the
 * database being touched at all — `signedInVisitor` returns on the missing cookie.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const visitor = await resolveVisitor();

  // Being signed in decides *whether* the labels are rendered. It is not what they
  // are, so it is not what they are called.
  return visitor ? <Labels visitor={visitor} /> : <Landing />;
}

/**
 * Who is signed in, or nobody.
 *
 * A failure to answer is not allowed to keep the page from rendering. Not knowing
 * whether somebody is signed in is a reason to offer them a sign-in, not a reason
 * to answer an error: this is the page that has to work when nothing else does,
 * and the landing page is the answer that is safe to give a stranger. Falling this
 * way cannot leak anything — a visitor treated as signed out is shown no labels.
 */
async function resolveVisitor(): Promise<SignedInVisitor | null> {
  try {
    return await currentVisitor();
  } catch (error) {
    report("could not resolve a session", error);
    return null;
  }
}

/** The public page: what the product is, and the way in. */
function Landing() {
  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-10 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 border-b border-rule pb-5 sm:mb-14">
        <div className="flex items-baseline gap-4">
          <h1 className="font-display text-[19px] tracking-[-0.01em]">Inbox Labeler</h1>
          <p className="text-[12.5px] text-ink-faint">Teach your AI how to organize your inbox.</p>
        </div>
        <SignIn />
      </header>

      <PolicyGraph />

      {/*
        Linked rather than merely present: Google's OAuth branding step asks for a
        home page, a privacy policy and terms on the app's own domain, and a page
        nothing points at is one nobody — reviewer or user — is expected to find.
      */}
      <footer className="mt-14 border-t border-rule pt-5 sm:mt-20">
        <LegalLinks />
      </footer>
    </main>
  );
}

/** The same address, signed in: this user's labels, and nobody else's. */
async function Labels({ visitor }: { visitor: SignedInVisitor }) {
  const labels = await readLabels(visitor);

  return (
    <main className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <AccountHeader email={visitor.email} />

      <h2 className="font-display mb-4 text-[15px] tracking-[-0.01em]">Labels</h2>

      {labels === "unavailable" ? (
        <Notice>
          <span className="block text-ink">Your labels could not be read just now</span>
          <span className="mt-1.5 block text-[12.5px] text-ink-faint">
            Nothing has been changed. Try again in a moment.
          </span>
        </Notice>
      ) : (
        <LabelList labels={labels} />
      )}

      <footer className="mt-14 border-t border-rule pt-5 sm:mt-20">
        <LegalLinks />
      </footer>
    </main>
  );
}

/**
 * A form rather than a link, and a POST rather than a GET.
 *
 * Starting a sign-in parks a record and sets a cookie, so it has to be something a
 * person did: a GET would be reachable by a prefetch, a link preview or another
 * site's image tag. The endpoint refuses a request that did not come from this
 * origin — see lib/web/signin.ts.
 */
function SignIn() {
  return (
    <form action="/auth/signin" method="post">
      <button
        type="submit"
        className="cursor-pointer rounded-md border border-rule bg-white/60 px-3.5 py-2 text-[12.5px] text-ink transition-colors hover:border-ink-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        Sign in with Google
      </button>
    </form>
  );
}

/**
 * This user's labels, through the same store `get_labels` reads.
 *
 * Not through the MCP endpoint. That would mean this server holding an access
 * token for its own visitor and talking to itself over HTTP to read a table it is
 * already connected to — and two paths to the same policy that could disagree.
 * One store, one set of rules, one answer.
 *
 * Reading them never creates anything. An account with no labels is a normal state
 * with an obvious next step, not a page that quietly writes a starter set on its
 * way to being rendered.
 */
async function readLabels(visitor: SignedInVisitor): Promise<Label[] | "unavailable"> {
  try {
    return await (await inboxStore(visitor.user)).labels();
  } catch (error) {
    report("could not read labels", error);
    return "unavailable";
  }
}

/**
 * A failure, for whoever runs this deployment.
 *
 * The message only, never the thrown object and never anything identifying the
 * user: a database error's message names what went wrong with the statement, which
 * is what an operator needs, and the rest of it can carry values. Nothing from here
 * reaches the browser — the page shows the landing content, or says that something
 * could not be read, and stops.
 */
function report(what: string, error: unknown): void {
  console.error(
    `[inboxlabeler] home: ${what}: ${error instanceof Error ? error.message : "unknown error"}`,
  );
}
