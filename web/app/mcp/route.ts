import { handleMcpRequest } from "@/lib/mcp/endpoint";

/**
 * The remote MCP endpoint, eventually https://inboxlabeler.com/mcp.
 *
 * Route plumbing only: the boundary, the protocol and the tools all live in
 * lib/mcp, so that none of them can only be reached through Next.js and all of
 * them can be tested without it.
 *
 * All three methods go to the same place. POST carries every MCP message; GET
 * and DELETE belonged to the session mechanics of the 2025 transport, which the
 * current revision removed, and the SDK answers them with the 405 the
 * specification asks for — as long as the caller got past the token check,
 * which is the first thing that happens either way.
 */

/**
 * Never prerendered. This endpoint reads the deployment's configuration and a
 * request's own credentials; a build has neither, and a cached answer would be
 * one user's answer given to the next.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

export async function GET(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handleMcpRequest(request);
}
