import { redirect } from "next/navigation";

import { LabelView } from "@/components/label-view";
import { NotHere, SignedIn, Unavailable } from "@/components/signed-in";
import type { Label } from "@/lib/inbox/labels";
import { inboxStore } from "@/lib/inbox/store";
import { connectionsOf } from "@/lib/label-list";
import { findLabel, single } from "@/lib/web/screens";
import { resolveVisitor, type SignedInVisitor } from "@/lib/web/visitor";

/**
 * One label's screen: `/label?name=…`.
 *
 * Signed in only; anybody else is sent to `/`, which is the landing page for them.
 * Whose label it is comes from the session, through `resolveVisitor`, exactly as
 * on `/`; the query only says which of that person's labels to show, and is looked
 * up in what has already been read for them. A name they do not have — renamed,
 * deleted, or typed — is "not here".
 *
 * It reads and shows; nothing on a label's screen writes. See
 * `components/label-view.tsx`.
 *
 * Never prerendered and never cached, for the reasons `/` is not, and the headers
 * that say so to every cache in between are in `next.config.ts`.
 */
export const dynamic = "force-dynamic";

export default async function LabelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const visitor = await resolveVisitor();
  if (!visitor) redirect("/");

  const query = await searchParams;
  const labels = await readLabels(visitor);
  if (labels === "unavailable") {
    return (
      <SignedIn email={visitor.email}>
        <Unavailable />
      </SignedIn>
    );
  }

  const label = findLabel(labels, single(query.name));
  if (!label) {
    return (
      <SignedIn email={visitor.email}>
        <NotHere />
      </SignedIn>
    );
  }

  // The derived labels it feeds, read off the edge list rather than the labels,
  // so a reference to a label this user does not have is dropped here the same
  // way it is in the label lists.
  const feeds = connectionsOf(labels)
    .filter((connection) => connection.from === label.label)
    .map((connection) => connection.to);

  return (
    <SignedIn email={visitor.email}>
      <LabelView label={label} feeds={feeds} />
    </SignedIn>
  );
}

/**
 * This user's labels, through the same store `get_labels` reads, opened for the
 * session's owner and nobody else. A read: nothing here creates, changes or
 * records anything.
 *
 * A failure is reported for whoever runs the deployment as its message only, never
 * the thrown object, and the page says that the labels could not be read.
 */
async function readLabels(visitor: SignedInVisitor): Promise<Label[] | "unavailable"> {
  try {
    return await (await inboxStore(visitor.user)).labels();
  } catch (error) {
    console.error(
      `[inboxlabeler] label: could not read the labels: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return "unavailable";
  }
}
