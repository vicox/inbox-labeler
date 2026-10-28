"use client";

import { useMemo, useState } from "react";

import { matchDisplay, matchesPerDay, type Matches } from "@/lib/activity";
import { byFrequency, connectionsOf, emphasis, type Label } from "@/lib/label-stream";
import { LabelCard } from "./label-card";

/**
 * The labels one account has, as one stream: a single narrow list, busiest first,
 * whatever kind of label each one is. A derived label still names what it is built
 * from, and each card opens its label's own screen (`app/label`), which says what
 * kind it is.
 *
 * Given its data rather than fetching it. The page above is a Server Component
 * that has already opened the signed-in user's store, so there is nothing here to
 * fetch and no endpoint to fetch it from — which also means there is no request
 * this component could be made to send on somebody else's behalf. A client
 * component only because pointing at a label lights up what it draws on; the
 * data arrives already decided.
 */
export function LabelStream({ labels, matches }: { labels: Label[]; matches: Matches }) {
  const [focused, setFocused] = useState<string | null>(null);

  /**
   * The relationships are no longer drawn, but they still decide what lights up:
   * pointing at a label picks out the ones it draws on, or the ones that draw on
   * it, and fades the rest.
   */
  const connections = useMemo(() => connectionsOf(labels), [labels]);
  const lit = useMemo(() => emphasis(focused, connections), [focused, connections]);

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
  // reports its age against the same moment, and the list is ordered against it.
  const now = new Date();

  // Ordered here rather than memoised: the order depends on `now`, which changes
  // every render, so memoising would only add a dependency that never holds.
  // Twenty-five labels cost nothing to sort.
  const ordered = byFrequency(labels, (label) => matchesPerDay(matches[label.label], now));

  /**
   * The detection labels a derived label is built from. Read off the edge list
   * rather than the label, so a reference to a label this user does not have is
   * filtered out here the same way it is everywhere else.
   *
   * Only derived labels carry these. A detection label's own relationships — the
   * derived labels it feeds — are reachable by pointing at it, which lights them
   * up, and on its own screen.
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
      dimmed={lit !== null && !lit.has(label.label)}
      lit={lit?.has(label.label) ?? false}
      onEnter={() => setFocused(label.label)}
      onLeave={() => setFocused(null)}
    />
  );

  // Headed, so the cards read as this account's labels rather than as a list
  // that arrived without a name. The count beside it is detection / derived,
  // taken from the cards below.
  const detection = ordered.filter((label) => label.type === "detection").length;
  const derived = ordered.filter((label) => label.type === "derived").length;

  return (
    <div className="mx-auto max-w-xl">
      <h2 className="mb-4 font-display text-[22px] tracking-[-0.01em]">
        Labels{" "}
        <span className="font-sans text-[12px] tracking-normal text-ink-faint tabular-nums">
          ({detection} / {derived})
        </span>
      </h2>
      <div className="flex flex-col gap-3">{ordered.map(card)}</div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="py-24 text-center text-[14px] text-ink-soft">{children}</p>;
}
