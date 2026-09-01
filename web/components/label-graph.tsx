"use client";

import { useMemo, useState } from "react";

import { matchDisplay, matchesPerDay, type Matches } from "@/lib/activity";
import { connectionsOf, emphasis, groupLabels, type Label, type LabelGroup } from "@/lib/label-graph";
import { LabelCard } from "./label-card";
import { LabelDetail } from "./label-detail";

/**
 * The labels one account has, as the groups they divide into: the two kinds of
 * fact a detection label states, the conclusions drawn from them, and — only when
 * there are any — the detection labels nobody has sorted yet.
 *
 * Given its data rather than fetching it. The page above is a Server Component
 * that has already opened the signed-in user's store, so there is nothing here to
 * fetch and no endpoint to fetch it from — which also means there is no request
 * this component could be made to send on somebody else's behalf. A client
 * component only because pointing at a label lights up what it draws on, and
 * opening one shows its instruction; the data arrives already decided.
 */
export function LabelGraph({ labels, matches }: { labels: Label[]; matches: Matches }) {
  const [focused, setFocused] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  /**
   * The relationships are no longer drawn, but they still decide what lights up:
   * pointing at a label picks out the ones it draws on, or the ones that draw on
   * it, and fades the rest.
   */
  const connections = useMemo(() => connectionsOf(labels), [labels]);
  const lit = useMemo(() => emphasis(focused, connections), [focused, connections]);

  // Nothing configured yet. Two panels reading zero would look like a verdict on
  // this account's mail rather than on its setup, so the space says what is
  // missing and where it comes from. Nothing is created by saying so.
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

  const openedLabel = labels.find((l) => l.label === opened) ?? null;
  const feeds = openedLabel
    ? connections.filter((c) => c.from === openedLabel.label).map((c) => c.to)
    : [];

  // One reading of the clock for the whole render, so every card on the page
  // reports its age against the same moment, and both columns order against it.
  const now = new Date();

  // Grouped here rather than memoised: the order inside each group depends on
  // `now`, which changes every render, so memoising would only add a dependency
  // that never holds. Twenty-five labels cost nothing to sort.
  const rate = (label: Label) => matchesPerDay(matches[label.label], now);
  const groups = groupLabels(labels, rate);

  // One parameter only: this goes straight into Array.map, which passes the index
  // as a second argument to anything that takes one.
  /**
   * The detection labels a derived label is built from. Read off the edge list
   * rather than the label, so a reference to a label this user does not have is
   * filtered out here the same way it is everywhere else.
   *
   * Only derived labels carry these. A detection label's own relationships — the
   * derived labels it feeds — are reachable by pointing at it, which lights them
   * up, and by opening it.
   */
  const referencesOf = (label: Label) =>
    label.type === "derived"
      ? connections
          .filter((c) => c.to === label.label)
          .map((c) => ({ name: c.from, suggested: c.kind === "recommended" }))
      : [];

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
      onOpen={() => setOpened(label.label)}
    />
  );

  // The three model groups share a row where there is room for one; `No role` is
  // deliberately outside it. It comes and goes with the account rather than with
  // the layout, and a conditional cell would reflow the other three when it did.
  const model = groups.filter((group) => group.key !== "no-role");
  const unsorted = groups.find((group) => group.key === "no-role");

  return (
    <>
      {/* Categories and Attributes pair off first — both are facts about the mail.
          Derived takes the width beneath them until there is room for three
          abreast, because its cards carry the labels they are built from. */}
      <div className="grid gap-6 md:grid-cols-2 md:gap-x-10 lg:grid-cols-3 lg:gap-x-12">
        {model.map((group) => (
          <Panel
            key={group.key}
            group={group}
            className={
              group.key === "derived" && model.length > 2 ? "md:col-span-2 lg:col-span-1" : ""
            }
          >
            {group.labels.map(card)}
          </Panel>
        ))}
      </div>

      {/* Rendered only because there is something in it. Full width and last: it
          is a gap in the model rather than a part of it, and reads as one there. */}
      {unsorted && (
        <div className="mt-6">
          <Panel group={unsorted}>{unsorted.labels.map(card)}</Panel>
        </div>
      )}

      {openedLabel && (
        <LabelDetail label={openedLabel} feeds={feeds} onClose={() => setOpened(null)} />
      )}
    </>
  );
}

/**
 * One group, on the one label surface.
 *
 * Derived sits on the mint surface and the other three on the warm one, because
 * `Categories`, `Attributes` and `No role` all hold facts read off the mail and
 * differ only in how they were modelled — which their headings already say. The
 * cards inside a panel carry its surface a step lighter.
 */
function Panel({
  group,
  className = "",
  children,
}: {
  group: LabelGroup;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-2xl border p-5 sm:p-7 ${
        group.key === "derived" ? "border-derived-rule bg-derived" : "border-label-rule bg-label"
      } ${className}`}
    >
      <header className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h2 className="font-display text-[22px] leading-none tracking-[-0.01em]">{group.title}</h2>
        <span className="text-[12px] text-ink-faint tabular-nums">{group.labels.length}</span>
        <p className="w-full text-[12.5px] text-ink-soft">{group.note}</p>
      </header>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="py-24 text-center text-[14px] text-ink-soft">{children}</p>;
}
