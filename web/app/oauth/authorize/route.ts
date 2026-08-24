import { handleAuthorize, handleConsent } from "@/lib/oauth/authorization";

/**
 * The authorization endpoint. GET asks the user; POST is their answer.
 * See lib/oauth/authorization.ts.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleAuthorize(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleConsent(request);
}
