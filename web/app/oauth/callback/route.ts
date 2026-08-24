import { handleProviderCallback } from "@/lib/oauth/callback";

/**
 * Where the identity provider returns the user. See lib/oauth/callback.ts.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleProviderCallback(request);
}
