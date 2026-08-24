import { oauthMetadataResponse } from "@modelcontextprotocol/server";

import { deployment } from "./config.ts";
import { authMetadataOptions } from "./metadata.ts";
import { configurationFault } from "./responses.ts";

/**
 * Serves whichever discovery document a request is asking for.
 *
 * Both well-known routes come through here, because the SDK's helper matches on
 * the request's own path and builds either document from one set of options —
 * so the two routes stay two files (Next.js routes by directory) without
 * becoming two descriptions of the same server that could drift apart.
 *
 * `undefined` from the helper means the path was neither document, which can
 * only happen if a route file moves away from the path RFC 9728 specifies. A
 * 404 is the honest answer, and the message says where to look.
 */
export function discoveryResponse(request: Request): Response {
  let response: Response | undefined;
  try {
    response = oauthMetadataResponse(request, authMetadataOptions(deployment()));
  } catch (error) {
    return configurationFault(error);
  }

  return (
    response ??
    Response.json(
      {
        error: "not_found",
        error_description:
          "No OAuth metadata is published at this path. Expected /.well-known/oauth-protected-resource/mcp or /.well-known/oauth-authorization-server.",
      },
      { status: 404 },
    )
  );
}
