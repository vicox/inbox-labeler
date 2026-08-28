import { handleSignIn } from "@/lib/web/signin";

/**
 * Starts a browser sign-in. POST only: see lib/web/signin.ts for why.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleSignIn(request);
}
