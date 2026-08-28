import { handleWebCallback } from "@/lib/web/signin";

/**
 * Where Google returns a browser. See lib/web/signin.ts.
 *
 * Called with the request alone: the handler's second parameter is the identity
 * provider, which only a test passes, and Next.js' own second argument to a route
 * handler is a context object that is not one.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleWebCallback(request);
}
