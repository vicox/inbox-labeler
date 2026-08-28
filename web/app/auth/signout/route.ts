import { handleSignOut } from "@/lib/web/signin";

/**
 * Ends a browser session. POST only: see lib/web/signin.ts for why.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleSignOut(request);
}
