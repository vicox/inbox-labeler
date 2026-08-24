import { discoveryResponse } from "@/lib/oauth/discovery";

/**
 * Authorization Server Metadata, per RFC 8414.
 *
 * Where a client learns the authorization, token and registration endpoints,
 * and which flows they support. Published at the origin because that is where
 * the Protected Resource Metadata document points, this deployment being both
 * the resource server and its own authorization server.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return discoveryResponse(request);
}
