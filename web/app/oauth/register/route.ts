import { handleRegistration } from "@/lib/oauth/registration";

/**
 * Dynamic Client Registration (RFC 7591). See lib/oauth/registration.ts.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleRegistration(request);
}
