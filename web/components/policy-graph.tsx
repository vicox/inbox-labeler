"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  byAttention,
  connectionsOf,
  emphasis,
  groupByDerived,
  type Label,
} from "@/lib/policy";
import { Connections, type Anchor } from "./connections";
import { LabelCard } from "./label-card";
import { LabelDetail } from "./label-detail";

/** Matches the gap-3 between cards in a column. */
const CARD_GAP = 12;

export function PolicyGraph() {
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [focused, setFocused] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/labels")
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not read the policy.");
        setLabels(body as Label[]);
      })
      .catch((cause: Error) => setError(cause.message));
  }, []);

  const detection = useMemo(
    () => byAttention((labels ?? []).filter((l) => l.type === "detection")),
    [labels],
  );
  const derived = useMemo(
    () => byAttention((labels ?? []).filter((l) => l.type === "derived")),
    [labels],
  );
  const connections = useMemo(() => connectionsOf(labels ?? []), [labels]);
  const lit = useMemo(() => emphasis(focused, connections), [focused, connections]);

  const { combined, alone } = useMemo(
    () => groupByDerived(detection, derived),
    [detection, derived],
  );

  // --- where the threads attach -------------------------------------------
  //
  // The cards are laid out by the browser, so their positions are only known
  // after paint. Anchors are measured relative to the container the threads are
  // drawn in, and re-measured whenever anything can have moved.

  const container = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [anchors, setAnchors] = useState(new Map<string, Anchor>());
  const [box, setBox] = useState({ width: 0, height: 0 });

  const measure = useCallback(() => {
    const element = container.current;
    if (!element) return;
    const base = element.getBoundingClientRect();
    const next = new Map<string, Anchor>();
    cards.current.forEach((card, name) => {
      const rect = card.getBoundingClientRect();
      const top = rect.top - base.top;
      next.set(name, {
        left: rect.left - base.left,
        right: rect.right - base.left,
        top,
        height: rect.height,
        y: top + rect.height / 2,
      });
    });
    setAnchors(next);
    setBox({ width: base.width, height: base.height });
  }, []);

  useLayoutEffect(measure, [measure, detection, derived]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // Final font metrics change every card's height, and with it every anchor.
    document.fonts?.ready.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [measure]);

  const cardRef = useCallback(
    (name: string) => (element: HTMLElement | null) => {
      if (element) cards.current.set(name, element);
      else cards.current.delete(name);
    },
    [],
  );

  /**
   * How far each derived card is pushed down, so that its centre sits level with
   * the middle of the detection labels it requires. Two inputs then meet it from
   * equal distances above and below, which is what makes a derived label read as
   * the pair coming together rather than as a continuation of the first one.
   *
   * Measured rather than assumed: a card's height depends on its text and on the
   * final font metrics. Cards are laid out in order and never overlap — where
   * centring would put one above the card before it, it follows on after it.
   */
  const offsets = useMemo(() => {
    const result = new Map<string, number>();
    const columnTop = combined.length ? anchors.get(combined[0].label)?.top : undefined;
    if (columnTop === undefined) return result;

    let previousBottom: number | null = null;
    for (const judgement of derived) {
      const self = anchors.get(judgement.label);
      if (!self) return new Map<string, number>();

      const inputs = (judgement.required_labels ?? [])
        .map((required) => anchors.get(required))
        .filter((anchor): anchor is Anchor => anchor !== undefined);

      const from = previousBottom === null ? columnTop : previousBottom + CARD_GAP;
      const target = inputs.length
        ? inputs.reduce((sum, anchor) => sum + anchor.y, 0) / inputs.length - self.height / 2
        : from;
      const top = Math.max(target, from);

      result.set(judgement.label, top - from);
      previousBottom = top + self.height;
    }
    return result;
  }, [anchors, derived, combined]);

  // Threads only make sense while the two panels stand side by side.
  const [sideBySide, setSideBySide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const sync = () => setSideBySide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  if (error) return <Notice>{error}</Notice>;
  if (!labels) return <Notice>Reading the policy…</Notice>;

  const openedLabel = labels.find((l) => l.label === opened) ?? null;
  const feeds = openedLabel
    ? connections.filter((c) => c.from === openedLabel.label).map((c) => c.to)
    : [];

  // One parameter only: this goes straight into Array.map, which would pass the
  // index as a second argument and silently offset every card by its position.
  const card = (label: Label) => (
    <LabelCard
      key={label.label}
      label={label}
      offset={sideBySide ? offsets.get(label.label) : undefined}
      dimmed={lit.labels !== null && !lit.labels.has(label.label)}
      lit={lit.labels?.has(label.label) ?? false}
      onEnter={() => setFocused(label.label)}
      onLeave={() => setFocused(null)}
      onOpen={() => setOpened(label.label)}
      cardRef={cardRef(label.label)}
    />
  );

  return (
    <>
      <div ref={container} className="relative">
        {/* Before the panels in the DOM: the panel surfaces paint under the
            threads, and the cards — being positioned and later — over them. */}
        {sideBySide && (
          <Connections
            connections={connections}
            anchors={anchors}
            lit={lit.connections}
            width={box.width}
            height={box.height}
          />
        )}

        <div className="grid gap-6 md:grid-cols-2 md:gap-x-24">
          <Panel
            tone="detection"
            title="Detection"
            note="Each one reads a message on its own."
            count={detection.length}
          >
            {combined.map(card)}
            {alone.map(card)}
          </Panel>

          <Panel
            tone="derived"
            title="Derived"
            note="Each one reads the detections it requires."
            count={derived.length}
          >
            {derived.map(card)}
          </Panel>
        </div>
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
