import {
  createMcpHandler,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

import { userRef, type AuthenticatedUser } from "../identity.ts";
import { inboxStore } from "../inbox/store.ts";
import { MCP_SCOPE, deployment, signingKey } from "../oauth/config.ts";
import { configurationFault } from "../oauth/responses.ts";
import { accessTokenVerifier } from "../oauth/tokens.ts";
import { inboxLabelerMcpServer } from "./server.ts";

/**
 * The MCP endpoint: one authorization boundary, then the server.
 *
 *     request
 *        ↓  Origin allowed?                    403 if not
 *        ↓  Bearer token valid for /mcp?       401 if not, 403 if under-scoped
 *        ↓  AuthenticatedUser
 *        ↓  MCP server bound to that user
 *      tool
 *
 * Everything above the last line happens once, here. A tool never sees a
 * header, a token or a claim — it is handed a server that already knows whose
 * session it is. That is deliberate and structural rather than a convention to
 * remember: `inboxLabelerMcpServer` cannot be called without an
 * `AuthenticatedUser`, so a future tool that forgets to check who is calling
 * does not compile, let alone answer.
 *
 * A missing token is not an anonymous user. There is no such thing here: the
 * gate answers 401 and the factory below never runs, so no code path exists in
 * which a tool has no one to attribute a request to.
 *
 * Kept apart from `app/mcp/route.ts` so that the boundary is testable as a
 * plain function of a `Request` — which is what the tests in this directory
 * exercise — and so the route stays thin enough to hold no logic worth testing.
 */

/**
 * The handler, built once.
 *
 * Its factory runs per request, and that is where the per-user binding happens;
 * what is shared is only the protocol plumbing. Built lazily rather than at
 * module load because it must not be constructed while a production build
 * renders routes.
 */
let handler: McpHttpHandler | undefined;

function mcpHandler(): McpHttpHandler {
  handler ??= createMcpHandler(async (ctx) => {
    const user = authenticatedUser(ctx.authInfo);
    // The store is opened for this user before any tool exists to call it, so a
    // tool has no opportunity to name a different one. See lib/inbox/store.ts.
    return inboxLabelerMcpServer({
      user,
      reference: userRef(user, signingKey()),
      store: await inboxStore(user),
    });
  });
  return handler;
}

/**
 * Serves one MCP request.
 *
 * The SDK's `createMcpHandler` speaks the current protocol revision
 * (2026-07-28) and falls back, per request, to the 2025-era shape for a client
 * that still opens with `initialize` — its default `legacy: 'stateless'`
 * posture. Both eras are served by the same factory, so the authenticated user
 * reaches a tool the same way whichever one a client speaks, and no client is
 * turned away for being a version behind.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  let auth: AuthInfo | Response;
  let allowedOrigins: string[];

  try {
    const config = deployment();
    const key = signingKey();

    // The transport specification requires an MCP server to validate `Origin`
    // against DNS rebinding. Only this deployment's own origin is allowed: MCP
    // clients are not browsers and send no `Origin` at all, which passes, so
    // the check costs a conforming client nothing and refuses the browser page
    // that is the attack.
    allowedOrigins = [config.hostname];

    auth = await requireBearerAuth({
      verifier: accessTokenVerifier(config, key),
      requiredScopes: [MCP_SCOPE],
      // What makes an unauthenticated 401 useful instead of a dead end: the
      // challenge carries this URL, and following it is how a client discovers
      // which authorization server to go and get a token from.
      resourceMetadataUrl: config.resourceMetadataUrl,
    })(request);
  } catch (error) {
    // A deployment that cannot check a token must refuse every request rather
    // than let one through unchecked. It is our fault, not the client's, so it
    // is a 500 and it does not pretend to be an authorization decision — and it
    // says nothing about what is misconfigured, which is the operator's business.
    return configurationFault(error);
  }

  const rejected = originValidationResponse(request, allowedOrigins);
  if (rejected) return rejected;

  if (auth instanceof Response) return auth;

  return mcpHandler().fetch(request, { authInfo: auth });
}

/**
 * The authenticated user behind a verified token.
 *
 * Throws when there is none. By construction there always is — the gate ran
 * first, and `accessTokenVerifier` refuses a token without a subject — so this
 * is the assertion that keeps that reasoning true if either of them ever
 * changes, rather than a case expected to happen. Returning an anonymous user
 * here would be the one mistake this whole file is arranged to prevent.
 */
function authenticatedUser(authInfo: AuthInfo | undefined): AuthenticatedUser {
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== "string" || !userId) {
    throw new Error("An MCP server was built without an authenticated user.");
  }
  return { id: userId };
}
