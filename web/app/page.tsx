import Link from "next/link";

import { LegalLinks } from "@/components/legal";
import { PolicyGraph } from "@/components/policy-graph";
import { currentVisitor } from "@/lib/web/visitor";

/**
 * Dynamic, because the header now depends on whether this browser is signed in.
 *
 * That costs the page its prerendering, which is worth stating rather than
 * assuming: a visitor with no session cookie is answered without the database
 * being touched at all — `signedInVisitor` returns on the missing cookie — so what
 * is actually given up is a cached shell for a page whose only content already
 * arrives from a request the browser makes itself.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  // Never allowed to keep the page from rendering. Not knowing whether somebody is
  // signed in is a reason to offer them a sign-in, not a reason to answer an error:
  // this is the page that has to work when nothing else does.
  let signedIn = false;
  try {
    signedIn = (await currentVisitor()) !== null;
  } catch {
    // Falls through to offering a sign-in.
  }

  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-10 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 border-b border-rule pb-5 sm:mb-14">
        <div className="flex items-baseline gap-4">
          <h1 className="font-display text-[19px] tracking-[-0.01em]">Inbox Labeler</h1>
          <p className="text-[12.5px] text-ink-faint">Teach your AI how to organize your inbox.</p>
        </div>
        {signedIn ? <OpenDashboard /> : <SignIn />}
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

function OpenDashboard() {
  return (
    <Link
      href="/dashboard"
      className="rounded-md border border-rule bg-white/60 px-3.5 py-2 text-[12.5px] text-ink transition-colors hover:border-ink-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      Open dashboard
    </Link>
  );
}
