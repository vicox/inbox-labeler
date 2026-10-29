import Link from "next/link";

import { LegalLinks } from "./legal";
import { Account, SiteHeader } from "./site-header";

/**
 * The frame every signed-in screen sits in, and the things one can say instead of
 * showing what was asked for.
 *
 * The label lists and a label's screen are one product read from one store, so they
 * share a header with the account in it, a width and a footer — written once here
 * rather than twice beside two pages.
 */
export function SignedIn({ email, children }: { email: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
      <SiteHeader>
        <Account email={email} />
      </SiteHeader>

      {children}

      <footer className="mt-14 border-t border-rule pt-5 sm:mt-20">
        <LegalLinks />
      </footer>
    </main>
  );
}

/** The store could not be read. Said plainly: reading it changes nothing. */
export function Unavailable() {
  return (
    <p className="py-24 text-center text-[14px] text-ink-soft">
      <span className="block text-ink">Your labels could not be read just now</span>
      <span className="mt-1.5 block text-[12.5px] text-ink-faint">
        Nothing has been changed. Try again in a moment.
      </span>
    </p>
  );
}

/**
 * A label a URL named and this person does not have — renamed, deleted, or never
 * there.
 *
 * The name is not repeated back: it is whatever was in the address bar, and the
 * page has nothing true to say about it beyond that it is not here.
 */
export function NotHere() {
  return (
    <div className="py-20 text-center">
      <p className="text-[14px] text-ink">Nothing here — it may have been renamed or deleted.</p>
      <p className="mt-4 text-[13px]">
        <BackToLabels />
      </p>
    </div>
  );
}

/** The way back to the label lists, at the top of a label's screen. */
export function BackToLabels() {
  return (
    <Link
      href="/"
      prefetch={false}
      className="inline-flex items-baseline gap-1.5 text-[12.5px] text-ink-soft underline decoration-transparent underline-offset-4 transition-colors hover:text-ink hover:decoration-rule focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      <span aria-hidden="true">←</span>
      Labels
    </Link>
  );
}
