import { McpServer } from "@modelcontextprotocol/server";

import type { AuthenticatedUser } from "../identity.ts";

/**
 * The MCP server InboxLabeler exposes, and the tools on it.
 *
 * Knows nothing about HTTP. It is handed an authenticated user and returns a
 * server; finding that user, and refusing the request when there isn't one,
 * happens at the boundary in `endpoint.ts`. That split is the point of this
 * file's shape: a tool added here cannot accidentally run unauthenticated,
 * because the only way to reach one is through a function that has to be given
 * a user first.
 *
 * There is one tool, deliberately. Reading and changing labels and matches is
 * the next step, and none of it belongs here yet — this exists to prove the path
 * from an MCP client through OAuth to an identified user, which is a thing that
 * either works or does not, and is much easier to see with nothing else on the
 * wire.
 */

/** Named in `serverInfo`, and what a client shows the user. */
const SERVER_NAME = "InboxLabeler";

/**
 * The MCP server's own version, which is the protocol surface's version and not
 * the web application's.
 *
 * At 0.x because this endpoint is a foundation and says so: the tools that make
 * it useful are not here yet.
 */
const SERVER_VERSION = "0.1.0";

/**
 * The session a server instance is built for: who is asking, and the safe name
 * for them.
 *
 * `reference` is derived from `user` and passed alongside rather than computed
 * here, so this file needs neither the signing key nor the configuration —
 * see `userRef` in `lib/identity.ts` for what makes it safe to hand out.
 */
export type McpSession = {
  user: AuthenticatedUser;
  reference: string;
};

/**
 * Builds a server bound to one authenticated user.
 *
 * A fresh instance per request, which is what the SDK's per-request factory
 * expects and what makes the binding trustworthy: the user is captured in this
 * closure, so a tool cannot read a different one and there is no shared
 * instance whose identity could be left over from the previous caller.
 */
export function inboxLabelerMcpServer(session: McpSession): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "get_server_info",
    {
      title: "Server information",
      description:
        "Reports that InboxLabeler's MCP endpoint is reachable and that this session is authenticated. Takes no arguments and reads nothing.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => {
      /**
       * `authenticated` is a constant, and that is the honest answer rather
       * than a stub. This code is only reachable through the bearer gate, so by
       * the time it runs the question has already been settled — an
       * unauthenticated caller never gets a tool result to read it in.
       *
       * `user` is the opaque reference, never the id. It is here so that two
       * sessions can be told apart while the foundation is being tested, which
       * is the whole reason to return anything about the user at all. What it
       * deliberately is not: the account, the email address, the token, or any
       * claim the identity provider sent.
       */
      const info = {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        authenticated: true,
        user: session.reference,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        structuredContent: info,
      };
    },
  );

  return server;
}
