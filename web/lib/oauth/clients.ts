/**
 * Client registration, and the redirect URI rules that make it safe.
 *
 * MCP clients are public clients: a desktop app or a hosted assistant that
 * cannot keep a secret, so none is issued and PKCE carries the proof instead.
 * That makes the redirect URI the load-bearing check in the whole flow. It is
 * the one thing that decides where an authorization code is delivered, so a
 * loose match here hands codes to whoever asked for the loose match — which is
 * why every rule below is about narrowing it.
 */

/** What a client sends to register, per RFC 7591. Everything else is ignored. */
export type ClientRegistrationRequest = {
  redirect_uris?: unknown;
  client_name?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
  application_type?: unknown;
};

export type ClientRegistrationError = {
  error: "invalid_client_metadata" | "invalid_redirect_uri";
  error_description: string;
};

/** The grants this authorization server issues, and nothing more. */
const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"];

/**
 * What one unauthenticated request may put in the store.
 *
 * None of these is a security boundary — a redirect URI is still matched
 * literally however long it is — but registration is open by design, so
 * everything it accepts needs a ceiling. Each limit is well past what a real
 * client needs and well below what would make the endpoint worth abusing.
 */
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2_048;
const MAX_CLIENT_NAME_LENGTH = 200;

/**
 * The largest registration document accepted, in bytes.
 *
 * A registration is a handful of short strings; four kilobytes is a generous
 * reading of that. The cap matters because the body is read into memory before
 * anything about it is known, so it is the one limit that has to be applied to
 * the bytes rather than to the parsed value.
 */
export const MAX_REGISTRATION_BYTES = 4 * 1024;

/**
 * Validates registration metadata, returning either the redirect URIs to store
 * or the reason to refuse.
 *
 * Pure: it decides, and the caller records. That is what lets every rule here
 * be tested without a store, a request or a running server.
 */
export function validateRegistration(
  request: ClientRegistrationRequest,
): { redirectUris: string[]; clientName?: string } | ClientRegistrationError {
  const { redirect_uris: uris } = request;

  if (!Array.isArray(uris) || uris.length === 0) {
    return {
      error: "invalid_redirect_uri",
      error_description: "redirect_uris is required and must contain at least one URI.",
    };
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return {
      error: "invalid_redirect_uri",
      error_description: `At most ${MAX_REDIRECT_URIS} redirect URIs may be registered.`,
    };
  }

  const redirectUris: string[] = [];
  for (const uri of uris) {
    if (typeof uri !== "string") {
      return { error: "invalid_redirect_uri", error_description: "Every redirect URI must be a string." };
    }
    if (uri.length > MAX_REDIRECT_URI_LENGTH) {
      return {
        error: "invalid_redirect_uri",
        error_description: `A redirect URI may be at most ${MAX_REDIRECT_URI_LENGTH} characters.`,
      };
    }
    const rejection = rejectRedirectUri(uri);
    if (rejection) return { error: "invalid_redirect_uri", error_description: rejection };
    redirectUris.push(uri);
  }

  // A client asking for a grant we do not issue is told now, at registration,
  // rather than at the token endpoint once a user has already been through a
  // browser for nothing.
  if (request.grant_types !== undefined) {
    if (!Array.isArray(request.grant_types)) {
      return { error: "invalid_client_metadata", error_description: "grant_types must be an array." };
    }
    const unsupported = request.grant_types.filter((grant) => !SUPPORTED_GRANT_TYPES.includes(grant as string));
    if (unsupported.length) {
      return {
        error: "invalid_client_metadata",
        error_description: `Unsupported grant_types: ${unsupported.join(", ")}. This server issues ${SUPPORTED_GRANT_TYPES.join(" and ")}.`,
      };
    }
  }

  // Public clients only. A client that wants to authenticate at the token
  // endpoint is asking for something this server does not do, and silently
  // treating it as public would leave it believing its secret meant something.
  const authMethod = request.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    return {
      error: "invalid_client_metadata",
      error_description:
        "Only public clients are supported: token_endpoint_auth_method must be \"none\", with PKCE proving the exchange.",
    };
  }

  if (request.response_types !== undefined) {
    if (!Array.isArray(request.response_types) || request.response_types.some((type) => type !== "code")) {
      return {
        error: "invalid_client_metadata",
        error_description: "response_types must be [\"code\"]: this server supports the authorization code flow only.",
      };
    }
  }

  // A name is shown to the user on the consent page, so its length is a
  // presentation concern as much as a storage one: a client cannot push the
  // redirect host off the page by calling itself something enormous.
  const name = typeof request.client_name === "string" ? request.client_name : undefined;
  if (name !== undefined && name.length > MAX_CLIENT_NAME_LENGTH) {
    return {
      error: "invalid_client_metadata",
      error_description: `client_name may be at most ${MAX_CLIENT_NAME_LENGTH} characters.`,
    };
  }

  return { redirectUris, clientName: name };
}

/**
 * Why a redirect URI is unacceptable, or nothing if it is fine.
 *
 * Three rules, each closing a way a code could be delivered somewhere it
 * should not be:
 *
 * - **Absolute, with no fragment.** A relative URI has no unambiguous target,
 *   and a fragment is not ours to set — the authorization response puts its own
 *   parameters there, so a registered fragment could only collide with them.
 * - **HTTPS, or HTTP on loopback.** An authorization code in flight over plain
 *   HTTP is readable by the network. Loopback is the documented exception,
 *   because a native client's callback never leaves the machine — and it is the
 *   exception that lets a desktop MCP client work at all.
 * - **No wildcards, and no userinfo.** Both exist to make a URI match more than
 *   one destination, which is the opposite of what registration is for.
 */
function rejectRedirectUri(uri: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return `Redirect URI must be an absolute URI: ${uri}`;
  }

  if (parsed.hash) return `Redirect URI must not contain a fragment: ${uri}`;
  if (parsed.username || parsed.password) return `Redirect URI must not contain userinfo: ${uri}`;
  if (uri.includes("*")) return `Redirect URI must not contain a wildcard: ${uri}`;

  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol === "https:") return undefined;
  if (parsed.protocol === "http:" && loopback) return undefined;

  // Anything else is a private scheme — a native client's `myapp://` callback.
  // Rejected because this server cannot tell one app's scheme from another's,
  // so honouring it would mean trusting a claim it has no way to check.
  return `Redirect URI must use https, or http on a loopback address: ${uri}`;
}

/**
 * Whether a client may be redirected to this URI.
 *
 * A literal string comparison against what was registered, which is the point.
 * Every softer rule anyone has tried here — matching a prefix, ignoring the
 * query, allowing a subdirectory — has turned into a way to redirect an
 * authorization code somewhere the client never registered. There is nothing
 * to relax and no normalisation to be clever about: it either is the
 * registered URI or it is not.
 */
export function isRegisteredRedirectUri(registered: readonly string[], candidate: string): boolean {
  return registered.includes(candidate);
}
