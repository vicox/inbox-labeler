/**
 * The consent page, and why there is one.
 *
 * This server holds a single registered application with the identity provider
 * — one static client id, shared by every MCP client that registers here. That
 * is what makes a consent step mandatory rather than polite. The provider
 * remembers a user's approval of *our* application, so once one user has
 * approved it, a later forward to the provider can complete from their existing
 * session without showing them anything. An attacker who registered their own
 * client and redirect URI could then walk a logged-in user through this endpoint
 * and collect an authorization code, in silence.
 *
 * The MCP authorization specification's security considerations require exactly
 * this mitigation of it: a server using a static client id **MUST** obtain user
 * consent for each dynamically registered client before forwarding to a
 * third-party authorization server. The page below is that consent, and the
 * approval it collects is the only thing that starts the forward.
 *
 * It is intentionally plain HTML with inline styles, served straight from the
 * route. It is not part of the InboxLabeler application: it borrows nothing from
 * its layout, its fonts or its components, so nothing about the product's own
 * pages can change what a security prompt looks like — or be changed by it.
 */

export type ConsentPrompt = {
  /** The client's self-declared name, or nothing if it registered without one. */
  clientName?: string;
  /** Where the client will be sent back to. Shown, because the user is trusting it. */
  redirectUri: string;
  /** The single-use reference that both resumes the request and proves this form was served. */
  reference: string;
  /** Where the approval is posted, which is this endpoint's own URL. */
  action: string;
};

/**
 * Renders the prompt.
 *
 * Every interpolated value is escaped. Two of them — the client's name and its
 * redirect URI — arrived from an unauthenticated registration request, so they
 * are attacker-controlled text being written into a page on this origin. That is
 * a scripting injection if it goes in raw, and this is the page where it would
 * do the most damage.
 *
 * The redirect URI's host is given its own line and stated plainly. The
 * specification asks for the hostname to be displayed during authorization, and
 * it is the one thing on the page that says where an approval actually leads: a
 * name is a claim the client made about itself, while the host is where the code
 * will go.
 */
export function consentPage(prompt: ConsentPrompt): string {
  const name = prompt.clientName?.trim();
  const host = hostOf(prompt.redirectUri);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Connect to InboxLabeler</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 2rem 1.25rem;
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: Canvas; color: CanvasText;
  }
  main { width: 100%; max-width: 27rem; }
  h1 { font-size: 1.15rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1rem; }
  dl { margin: 0 0 1.5rem; padding: 0.9rem 1rem; border: 1px solid; border-radius: 8px; }
  dt { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
  dd { margin: 0.15rem 0 0.85rem; overflow-wrap: anywhere; }
  dd:last-of-type { margin-bottom: 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
  .actions { display: flex; gap: 0.6rem; }
  button {
    font: inherit; padding: 0.55rem 1.1rem; border-radius: 7px;
    border: 1px solid; cursor: pointer; background: transparent; color: inherit;
  }
  button[name="approve"] { background: CanvasText; color: Canvas; }
  small { display: block; margin-top: 1.25rem; opacity: 0.7; }
</style>
</head>
<body>
<main>
  <h1>Connect to InboxLabeler?</h1>
  <p>${name ? `<strong>${escapeHtml(name)}</strong> is asking` : "An application is asking"}
     to sign in to InboxLabeler as you and use its MCP tools on your behalf.</p>
  <dl>
    <dt>Application</dt>
    <dd>${name ? escapeHtml(name) : "<em>did not give a name</em>"}</dd>
    <dt>Will be sent back to</dt>
    <dd><code>${escapeHtml(host)}</code></dd>
  </dl>
  <p>Approving takes you to Google to sign in. InboxLabeler learns which Google
     account you are, and nothing else about it.</p>
  <form method="post" action="${escapeHtml(prompt.action)}">
    <input type="hidden" name="request" value="${escapeHtml(prompt.reference)}">
    <div class="actions">
      <button type="submit" name="approve" value="yes">Approve</button>
      <button type="submit" name="deny" value="yes">Cancel</button>
    </div>
  </form>
  <small>Only approve this if you started it. Check the address above is one you recognise.</small>
</main>
</body>
</html>
`;
}

/**
 * The redirect URI reduced to what a person can judge.
 *
 * Host and port, dropping the path and query: a long URI invites skimming, and
 * the authority is the part that decides who receives the code. A URI that will
 * not parse is shown whole rather than hidden, since the user is better served
 * seeing something they can tell is wrong.
 */
function hostOf(redirectUri: string): string {
  try {
    return new URL(redirectUri).host || redirectUri;
  } catch {
    return redirectUri;
  }
}

/**
 * Escapes text for HTML, including in a double-quoted attribute.
 *
 * All five characters, not the usual three. `"` because these values are
 * interpolated into attributes, where closing the quote early is enough to add
 * one of your own; `'` for the same reason under a different quoting style.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
