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
 * A client may register at most this many redirect URIs.
 *
 * Not a security boundary — every one of them is still checked literally — but
 * a bound on what one unauthenticated request can put in the store. Well past
 * what a real client needs.
 */
const MAX_REDIRECT_URIS = 10;

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

  return {
    redirectUris,
    clientName: typeof request.client_name === "string" ? request.client_name : undefined,
  };
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
