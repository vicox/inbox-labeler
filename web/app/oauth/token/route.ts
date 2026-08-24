import { handleToken } from "@/lib/oauth/exchange";

/**
 * The token endpoint. See lib/oauth/exchange.ts.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleToken(request);
}
