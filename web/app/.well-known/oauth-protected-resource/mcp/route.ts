import { discoveryResponse } from "@/lib/oauth/discovery";

/**
 * Protected Resource Metadata for /mcp, per RFC 9728.
 *
 * The document the MCP authorization specification requires an MCP server to
 * publish, and the first thing a client reads: the 401 from /mcp points here,
 * and this names the authorization server to go to next. The path mirrors the
 * resource's own — /mcp becomes /.well-known/oauth-protected-resource/mcp —
 * which is RFC 9728's rule, not a choice.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return discoveryResponse(request);
}
