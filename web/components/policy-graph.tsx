"use client";

import { useEffect, useMemo, useState } from "react";

import { matchDisplay, matchesPerDay, type Matches } from "@/lib/activity";
import { byRelevance, connectionsOf, emphasis, type Label } from "@/lib/policy";
import { LabelCard } from "./label-card";
import { LabelDetail } from "./label-detail";

export function PolicyGraph() {
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [matches, setMatches] = useState<Matches>({});
  const [error, setError] = useState<string | null>(null);

  const [focused, setFocused] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/labels")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not read the policy.");
        setLabels(body.labels as Label[]);
        // No history is a normal state, so it never reaches the error branch.
        setMatches((body.matches ?? {}) as Matches);
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);

  /**
   * The relationships are no longer drawn, but they still decide what lights up:
   * pointing at a label picks out the ones it draws on, or the ones that draw on
   * it, and fades the rest.
   */
  const connections = useMemo(() => connectionsOf(labels ?? []), [labels]);
  const lit = useMemo(() => emphasis(focused, connections), [focused, connections]);

  if (error) return <Notice>{error}</Notice>;
  if (!labels) return <Notice>Reading the policy…</Notice>;

  const openedLabel = labels.find((l) => l.label === opened) ?? null;
  const feeds = openedLabel
    ? connections.filter((c) => c.from === openedLabel.label).map((c) => c.to)
    : [];

  // One reading of the clock for the whole render, so every card on the page
  // reports its age against the same moment, and both columns order against it.
  const now = new Date();

  // Ordered here rather than memoised: the order depends on `now`, which changes
  // every render, so memoising it would only add a dependency that never holds.
  // Twenty-five labels cost nothing to sort.
  const rate = (label: Label) => matchesPerDay(matches[label.label], now);
  const detection = byRelevance(
    labels.filter((l) => l.type === "detection"),
    rate,
  );
  const derived = byRelevance(
    labels.filter((l) => l.type === "derived"),
    rate,
  );

  // One parameter only: this goes straight into Array.map, which passes the index
  // as a second argument to anything that takes one.
  const card = (label: Label) => (
    <LabelCard
      key={label.label}
      label={label}
      {...matchDisplay(matches[label.label], now)}
      lastAt={matches[label.label]?.last_matched_at}
      dimmed={lit !== null && !lit.has(label.label)}
      lit={lit?.has(label.label) ?? false}
      onEnter={() => setFocused(label.label)}
      onLeave={() => setFocused(null)}
      onOpen={() => setOpened(label.label)}
    />
  );

  return (
    <>
      {/* No items-start: the two panels stay the same height whichever of them
          holds more labels. */}
      <div className="grid gap-6 md:grid-cols-2 md:gap-x-24">
        <Panel
          tone="detection"
          title="Detection"
          note="What's in the email?"
          count={detection.length}
        >
          {detection.map(card)}
        </Panel>

        <Panel
          tone="derived"
          title="Derived"
          note="What does it mean to you?"
          count={derived.length}
        >
          {derived.map(card)}
        </Panel>
      </div>

      {openedLabel && (
        <LabelDetail label={openedLabel} feeds={feeds} onClose={() => setOpened(null)} />
      )}
    </>
  );
}

function Panel({
  tone,
  title,
  note,
  count,
  children,
}: {
  tone: "detection" | "derived";
  title: string;
  note: string;
  count: number;
  children: React.ReactNode;
}) {
  const detection = tone === "detection";
  return (
    <section
      className={[
        "rounded-2xl border p-5 sm:p-7",
        detection ? "border-detection-rule bg-detection" : "border-derived-rule bg-derived",
      ].join(" ")}
    >
      {/* The note carries the only thing that tells the two detection panels
          apart, so it stays visible at every width. */}
      <header className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
        <h2 className="font-display text-[22px] leading-none tracking-[-0.01em]">{title}</h2>
        <span className="text-[12px] text-ink-faint tabular-nums">{count}</span>
        <p className="w-full text-[12.5px] text-ink-soft lg:ml-auto lg:w-auto">{note}</p>
      </header>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="py-24 text-center text-[14px] text-ink-soft">{children}</p>;
}
