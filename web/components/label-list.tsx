"use client";

import { useMemo } from "react";

import { matchDisplay, matchesPerDay, type Matches } from "@/lib/activity";
import { connectionsOf, listsOf, type Label } from "@/lib/label-list";
import { LabelCard } from "./label-card";

/**
 * The labels one account has, as two lists side by side: detection labels and
 * derived labels, each busiest first. On a narrow screen the derived list follows
 * the detection list instead. A derived label still names what it is built from,
 * and each card opens its label's own screen (`app/label`).
 *
 * Given its data rather than fetching it. The page above is a Server Component
 * that has already opened the signed-in user's store, so there is nothing here to
 * fetch and no endpoint to fetch it from — which also means there is no request
 * this component could be made to send on somebody else's behalf.
 */
export function LabelList({ labels, matches }: { labels: Label[]; matches: Matches }) {
  /**
   * The relationships are not drawn. A derived card names the detection labels it
   * is built from, and a label's own screen lists the rest.
   */
  const connections = useMemo(() => connectionsOf(labels), [labels]);

  // Nothing configured yet. An empty list would look like a verdict on this
  // account's mail rather than on its setup, so the space says what is missing
  // and where it comes from. Nothing is created by saying so.
  if (labels.length === 0) {
    return (
      <Notice>
        <span className="block text-ink">No labels yet</span>
        <span className="mt-1.5 block text-[12.5px] text-ink-faint">
          Ask your MCP client to set up Inbox Labeler, or to create a label, and it appears here.
        </span>
      </Notice>
    );
  }

  // One reading of the clock for the whole render, so every card on the page
  // reports its age against the same moment, and the lists are ordered against it.
  const now = new Date();

  // Ordered here rather than memoised: the order depends on `now`, which changes
  // every render, so memoising would only add a dependency that never holds.
  // Twenty-five labels cost nothing to sort.
  const { detection, derived } = listsOf(labels, (label) =>
    matchesPerDay(matches[label.label], now),
  );

  /**
   * The detection labels a derived label is built from. Read off the edge list
   * rather than the label, so a reference to a label this user does not have is
   * filtered out here the same way it is everywhere else.
   *
   * Only derived labels carry these. A detection label's own relationships — the
   * derived labels it feeds — are on its own screen.
   */
  const referencesOf = (label: Label) =>
    label.type === "derived"
      ? connections
          .filter((c) => c.to === label.label)
          .map((c) => ({ name: c.from, suggested: c.kind === "recommended" }))
      : [];

  // One parameter only: this goes straight into Array.map, which passes the index
  // as a second argument to anything that takes one.
  const card = (label: Label) => (
    <LabelCard
      key={label.label}
      label={label}
      {...matchDisplay(matches[label.label], now)}
      lastAt={matches[label.label]?.last_matched_at}
      references={referencesOf(label)}
    />
  );

  // Side by side from `md` up; stacked below it, where two columns would leave
  // each card narrower than a phone's.
  return (
    <div className="mx-auto grid max-w-5xl items-start gap-x-10 gap-y-12 md:grid-cols-2">
      <List title="Detection" empty="No detection labels yet" labels={detection} card={card} />
      <List title="Derived" empty="No derived labels yet" labels={derived} card={card} />
    </div>
  );
}

/**
 * One headed list. Headed, so the cards read as this account's labels of one kind
 * rather than as a list that arrived without a name; the count beside the heading
 * is the cards below it. A kind with none keeps its heading and says so, so the
 * other list does not look like the only one there is.
 */
function List({
  title,
  empty,
  labels,
  card,
}: {
  title: string;
  empty: string;
  labels: Label[];
  card: (label: Label) => React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-4 font-display text-[22px] tracking-[-0.01em]">
        {title}{" "}
        <span className="font-sans text-[12px] tracking-normal text-ink-faint tabular-nums">
          ({labels.length})
        </span>
      </h2>
      {labels.length > 0 ? (
        <div className="flex flex-col gap-3">{labels.map(card)}</div>
      ) : (
        <p className="text-[12.5px] text-ink-faint">{empty}</p>
      )}
    </section>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="py-24 text-center text-[14px] text-ink-soft">{children}</p>;
}
