import { LegalLinks } from "@/components/legal";
import { LabelGraph } from "@/components/label-graph";
import { Account, SiteHeader, SignIn } from "@/components/site-header";
import type { Label } from "@/lib/inbox/labels";
import type { Matches } from "@/lib/inbox/matches";
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
 * What is given up is a prerendered shell for the landing half, which is a heading
 * and a fixed notice — little enough that prerendering it was never worth much. A
 * visitor with no session cookie is still answered without the database being
 * touched at all: `signedInVisitor` returns on the missing cookie, and the landing
 * branch opens no store. Neither half fetches anything from the browser; the
 * signed-in columns are handed their data by this page.
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
      <SiteHeader>
        <SignIn />
      </SiteHeader>

      {/*
        The public page reads nothing. It once rendered the same columns against a
        local fixture file, which was a demo of the product rather than anybody's
        labels — and hosted there was no file, so this notice is what it showed. Now
        the columns belong to the signed-in page, where the labels are real, and the
        landing page states the one fact a stranger needs.
      */}
      <p className="py-24 text-center text-[14px] text-ink-soft">
        <span className="block text-ink">Closed beta</span>
        <span className="mt-1.5 block text-[12.5px] text-ink-faint">
          Connect Inbox Labeler through your MCP client.
        </span>
      </p>

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
  const account = await readAccount(visitor);

  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
      <SiteHeader>
        <Account email={visitor.email} />
      </SiteHeader>

      {account === "unavailable" ? (
        <p className="py-24 text-center text-[14px] text-ink-soft">
          <span className="block text-ink">Your labels could not be read just now</span>
          <span className="mt-1.5 block text-[12.5px] text-ink-faint">
            Nothing has been changed. Try again in a moment.
          </span>
        </p>
      ) : (
        <LabelGraph labels={account.labels} matches={account.matches} />
      )}

      <footer className="mt-14 border-t border-rule pt-5 sm:mt-20">
        <LegalLinks />
      </footer>
    </main>
  );
}

/**
 * This user's labels and how often each has matched, through the same store
 * `get_labels` and `get_matches` read.
 *
 * Not through the MCP endpoint. That would mean this server holding an access
 * token for its own visitor and talking to itself over HTTP to read tables it is
 * already connected to — and two paths to the same answer that could disagree.
 * One store, one set of rules, one answer.
 *
 * Both reads are reads. Nothing here creates a label, records a match, touches
 * Gmail or writes anything at all: an account with no labels is a normal state
 * with an obvious next step, not a page that quietly writes a starter set on its
 * way to being rendered, and a label with no history is a label that has not
 * matched rather than a gap to fill in.
 *
 * The store is opened once and both halves come from it, so they cannot be for
 * different users — there is only one `user` in this expression and it came from
 * the session.
 */
async function readAccount(
  visitor: SignedInVisitor,
): Promise<{ labels: Label[]; matches: Matches } | "unavailable"> {
  try {
    const store = await inboxStore(visitor.user);
    const [labels, matches] = await Promise.all([store.labels(), store.matches()]);
    return { labels, matches };
  } catch (error) {
    report("could not read the account", error);
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
