import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Matches } from "@/lib/activity";
import type { Label } from "@/lib/policy";

/**
 * The two files the Inbox Labeler persists: the policy, and how often each of
 * its labels has matched. They stay where they are — the same files the CLI and
 * the agents use — and both are gitignored because both are the user's own.
 *
 * The policy is required; the match history is not. A mailbox that has never
 * been processed has none, which is a normal state and not a failure.
 */
const POLICY_FILE = path.join(process.cwd(), "..", "data", "labels.json");
const MATCHES_FILE = path.join(process.cwd(), "..", "data", "matches.json");

/**
 * Read at request time, never at build time. Both files are private, so neither
 * may be baked into a build artifact — dynamic rendering keeps them out of the
 * bundle and out of any prerendered HTML, and leaves one obvious place to put an
 * authenticated backend later.
 */
export const dynamic = "force-dynamic";

/**
 * The match history, or none. Every way of not having one — no file, unreadable,
 * unparseable, the wrong shape — comes back the same way: an empty history, in
 * which every label reads as never matched. The counts are here to inform a page
 * about labels, and must never be the reason it fails to render one.
 */
async function readMatches(): Promise<Matches> {
  try {
    const parsed = JSON.parse(await readFile(MATCHES_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Matches;
  } catch {
    // Falls through to none.
  }
  return {};
}

export async function GET() {
  let contents: string;
  try {
    contents = await readFile(POLICY_FILE, "utf8");
  } catch {
    return Response.json(
      { error: "No policy yet. data/labels.json appears once you create a label." },
      { status: 404 },
    );
  }

  let labels: Label[];
  try {
    labels = JSON.parse(contents);
  } catch {
    return Response.json({ error: "data/labels.json is not valid JSON." }, { status: 500 });
  }

  if (!Array.isArray(labels)) {
    return Response.json({ error: "data/labels.json must contain an array." }, { status: 500 });
  }

  return Response.json(
    { labels, matches: await readMatches() },
    { headers: { "cache-control": "no-store" } },
  );
}
