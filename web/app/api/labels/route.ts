import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Label } from "@/lib/policy";

/**
 * The policy the skills read and write. It stays where it is: the file is the
 * source of truth for the CLI, the agents and this UI alike, and it is
 * gitignored because it is the user's own.
 */
const POLICY_FILE = path.join(process.cwd(), "..", "data", "labels.json");

/**
 * Read at request time, never at build time. The policy is private, so it must
 * not be baked into a build artifact — dynamic rendering keeps it out of the
 * bundle and out of any prerendered HTML, and leaves one obvious place to put an
 * authenticated backend later.
 */
export const dynamic = "force-dynamic";

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

  return Response.json(labels, {
    headers: { "cache-control": "no-store" },
  });
}
