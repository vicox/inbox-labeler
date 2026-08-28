import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DashboardHeader, LabelList, Notice } from "@/components/dashboard";
import { LegalLinks } from "@/components/legal";
import type { Label } from "@/lib/inbox/labels";
import { inboxStore } from "@/lib/inbox/store";
import { currentVisitor, type SignedInVisitor } from "@/lib/web/visitor";

/**
 * The signed-in dashboard: one user's labels, and nothing else's.
 *
 * Read-only, on purpose and for now. What this page exists to establish is that a
 * browser session resolves to the same InboxLabeler owner as an MCP client on the
 * same Google account, and that it can reach nobody else's labels; creating and
 * editing them from here is a separate change, and one worth making after that has
 * been demonstrated rather than alongside it.
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
 * the access list no longer admits are one outcome here: back to the home page,
 * where the only thing offered is signing in. They are not distinguished, because
 * to the person in front of the browser they mean the same thing, and because
 * saying which would report whether a guessed cookie had found a live session.
 *
 * A database failure is the one thing that is *not* answered that way. It is not
 * an authentication answer, and dressing it up as one would send somebody round a
 * sign-in loop that cannot succeed.
 */

export const metadata: Metadata = {
  title: "Dashboard — Inbox Labeler",
  // A page that exists only for one signed-in person has nothing to offer a
  // crawler, and a crawler that indexed its URL would only publish a sign-in
  // redirect.
  robots: { index: false, follow: false },
};

/**
 * Never prerendered and never cached. This page reads a session cookie and one
 * user's rows; a cached answer would be one person's labels handed to the next.
 */
export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const visitor = await resolveVisitor();

  // Outside any try/catch: `redirect` works by throwing, and a catch that
  // swallowed it would turn "sign in first" into a rendered page.
  if (visitor === "unavailable") return <Unavailable />;
  if (!visitor) redirect("/");

  const labels = await readLabels(visitor);

  return (
    <main className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <DashboardHeader email={visitor.email} />

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
 * The visitor, or why there is none.
 *
 * Three answers, because there are three different things to do about them, and
 * the failure is separated from the two authentication answers so that a database
 * that is briefly unreachable never reads as "you are not signed in".
 */
async function resolveVisitor(): Promise<SignedInVisitor | null | "unavailable"> {
  try {
    return await currentVisitor();
  } catch (error) {
    report("could not resolve a session", error);
    return "unavailable";
  }
}

/**
 * This user's labels, through the same store `get_labels` reads.
 *
 * Not through the MCP endpoint. That would mean this server holding an access
 * token for its own visitor and talking to itself over HTTP to read a table it is
 * already connected to — and two paths to the same policy that could disagree.
 * One store, one set of rules, one answer.
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
 * reaches the browser — the page says that something could not be read and stops.
 */
function report(what: string, error: unknown): void {
  console.error(
    `[inboxlabeler] dashboard: ${what}: ${error instanceof Error ? error.message : "unknown error"}`,
  );
}

/** The page when the database cannot be reached: no header, because there is no session to name. */
function Unavailable() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-10 border-b border-rule pb-5">
        <p className="font-display text-[19px] tracking-[-0.01em]">Inbox Labeler</p>
      </header>
      <Notice>
        <span className="block text-ink">Temporarily unavailable</span>
        <span className="mt-1.5 block text-[12.5px] text-ink-faint">
          The dashboard could not be loaded. Nothing has been changed. Try again in a moment.
        </span>
      </Notice>
      <footer className="mt-14 border-t border-rule pt-5">
        <LegalLinks />
      </footer>
    </main>
  );
}
