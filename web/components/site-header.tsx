/**
 * The site's header, which is one header in two states rather than two headers.
 *
 * The product name and what it is sit on the left, and whatever the visitor can do
 * about their session sits at the top right — signing in, or signing out. Keeping
 * the shell here rather than writing it out on each branch is what stops the two
 * from drifting apart: they cannot differ in width, rule, spacing or alignment,
 * because there is only one of each.
 *
 * What the header deliberately does *not* carry is the account's address. It would
 * have to go between the product name and the action, which pushes the action out
 * of the corner it belongs in and, at this page's width, wraps the whole right-hand
 * block onto a second line. It belongs next to the labels it explains the ownership
 * of; see `app/page.tsx`.
 */

/**
 * Both actions look the same because they are the same thing in the same place:
 * the one control this header offers. Defined once so they cannot drift.
 */
const ACTION =
  "cursor-pointer rounded-md border border-rule bg-white/60 px-3.5 py-2 text-[12.5px] text-ink transition-colors hover:border-ink-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

export function SiteHeader({ children }: { children: React.ReactNode }) {
  return (
    <header className="mb-10 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 border-b border-rule pb-5 sm:mb-14">
      <div className="flex items-baseline gap-4">
        <h1 className="font-display text-[19px] tracking-[-0.01em]">Inbox Labeler</h1>
        <p className="text-[12.5px] text-ink-faint">Teach your AI how to label your inbox.</p>
      </div>
      {children}
    </header>
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
export function SignIn() {
  return (
    <form action="/auth/signin" method="post">
      <button type="submit" className={ACTION}>
        Sign in with Google
      </button>
    </form>
  );
}

/**
 * The same, for the same reason and more so: signing out changes state on the
 * server, and a GET that changes state is one a prefetch, a scanner or another
 * site's image tag can perform on somebody's behalf. The POST is refused unless it
 * came from this origin — see lib/web/signin.ts.
 */
export function SignOut() {
  return (
    <form action="/auth/signout" method="post">
      <button type="submit" className={ACTION}>
        Sign out
      </button>
    </form>
  );
}
