import Link from "next/link";

import { LEGAL_UPDATED, type Operator } from "@/lib/legal";

/**
 * The frame the three legal pages share.
 *
 * Who the operator is comes from `lib/legal.ts` and is passed in, so nothing
 * here reads the environment: a component that renders an address should not
 * also decide whether one exists.
 */

/**
 * Links to all three pages, on every page including the home page.
 *
 * Google's OAuth branding step asks for a home page, a privacy policy and terms
 * on the app's own domain, and reachable means linked rather than merely
 * present. Repeating them across the legal pages means arriving at one of them
 * still leads to the other two.
 */
export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <nav className={`flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-ink-faint ${className}`}>
      <Link href="/" className="hover:text-ink-soft">
        Home
      </Link>
      <Link href="/privacy" className="hover:text-ink-soft">
        Privacy
      </Link>
      <Link href="/terms" className="hover:text-ink-soft">
        Terms
      </Link>
      <Link href="/impressum" className="hover:text-ink-soft">
        Impressum
      </Link>
    </nav>
  );
}

/**
 * The container the legal pages are written into.
 *
 * Narrower than the home page on purpose: the graph wants width and prose wants
 * a line short enough to read. Body text sits in `ink-soft` with headings in
 * `ink`, so structure carries the emphasis rather than weight or size — the same
 * restraint as the rest of the site.
 */
export function LegalPage({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-10 border-b border-rule pb-5">
        <div className="flex items-baseline gap-4">
          <Link href="/" className="font-display text-[19px] tracking-[-0.01em] hover:text-ink-soft">
            Inbox Labeler
          </Link>
          <p className="text-[12.5px] text-ink-faint">{title}</p>
        </div>
        <p className="mt-3 text-[12.5px] text-ink-faint">Last updated {LEGAL_UPDATED}</p>
      </header>

      <div
        className={
          "space-y-9 text-[14px] leading-[1.65] text-ink-soft " +
          "[&_h2]:font-display [&_h2]:text-[15px] [&_h2]:text-ink [&_h2]:tracking-[-0.01em] " +
          "[&_p]:mt-3 [&_ul]:mt-3 [&_ul]:space-y-1.5 [&_li]:pl-1 " +
          "[&_ul]:list-disc [&_ul]:pl-5 " +
          "[&_strong]:font-medium [&_strong]:text-ink " +
          "[&_code]:font-mono [&_code]:text-[12.5px] [&_code]:text-ink " +
          "[&_a]:text-ink [&_a]:underline [&_a]:decoration-rule [&_a]:underline-offset-2 " +
          "[&_a:hover]:decoration-ink-faint"
        }
      >
        {children}
      </div>

      <footer className="mt-14 border-t border-rule pt-5">
        <LegalLinks />
      </footer>
    </main>
  );
}

/** The operator's postal address, laid out the way an address is written. */
export function OperatorAddress({ operator }: { operator: Operator }) {
  return (
    <p className="mt-3 whitespace-pre-line">
      {[operator.name, ...operator.addressLines].join("\n")}
    </p>
  );
}
