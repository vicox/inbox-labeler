"use client";

import { groupOf, type Label, type LabelGroupKey } from "@/lib/label-graph";
import { AttentionMark } from "./attention-mark";

/**
 * A card's surface, by the kind of label it holds. One family lighter than the
 * matching panel in `label-graph.tsx`, and `no-role` borrows no family at all —
 * the page's own rule and a plain lift, because it is not a fourth kind.
 *
 * `groupOf` decides the key, so this cannot disagree with the panel the card sits
 * in. `label.attention` is deliberately absent: what a label asks of you is said
 * by its mark and in its detail panel, never by the colour of the card.
 */
const SURFACES: Record<LabelGroupKey, string> = {
  category: "border-category-rule bg-category-card",
  attribute: "border-attribute-rule bg-attribute-card",
  derived: "border-derived-rule bg-derived-card",
  "no-role": "border-rule bg-white/60",
};

type Props = {
  label: Label;
  /** Dimmed because something else is focused and this label is unrelated to it. */
  dimmed: boolean;
  /** Lit because it is focused, or connected to whatever is. */
  lit: boolean;
  /** About how often it matches, beside the name — null when there is no rate. */
  rate: string | null;
  /** When it last matched, under the name, or "Never matched". */
  last: string;
  /** The exact timestamp behind `last`, for the native tooltip. */
  lastAt?: string | null;
  /**
   * The detection labels a derived label is built from; empty on a detection
   * card. `suggested` marks the ones offered as context rather than required, and
   * `group` is the referenced label's own kind, which is what colours its chip.
   */
  references: { name: string; suggested?: boolean; group: LabelGroupKey }[];
  onEnter: () => void;
  onLeave: () => void;
  onOpen: () => void;
};

/**
 * One label, on either side. A card carries the colour of the kind of label it is,
 * one step lighter than the panel holding it, so a card read on its own says what
 * it is without its column — which is what the reference chips on a derived card
 * depend on.
 *
 * The name sits at the left and the rate at the right of the same line, with
 * when it last matched underneath. A derived label also names the detection
 * labels it is built from, between the two. The attention mark is further right
 * again, and holds elements of its own rather than being part of the card's
 * button, because it takes hover and focus separately from the card.
 */
export function LabelCard({
  label,
  dimmed,
  lit,
  rate,
  last,
  lastAt,
  references,
  onEnter,
  onLeave,
  onOpen,
}: Props) {
  const surface = SURFACES[groupOf(label)];

  return (
    // Positioned, so the attention mark can sit in the right-hand margin. The
    // relationship hover sits here rather than on the button so that it covers
    // that margin too, and keeps running while the pointer is on the mark.
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      className={[
        "relative transition duration-200 ease-out",
        dimmed ? "opacity-35" : "opacity-100",
        lit ? "-translate-y-px" : "",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${label.label}, ${label.type} label`}
        className={[
          "block w-full cursor-pointer rounded-lg border px-5 py-4 text-left",
          "min-h-[62px] transition-shadow duration-200 ease-out",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
          surface,
          lit ? "shadow-[0_1px_0_rgba(28,26,23,0.10)]" : "shadow-none",
        ].join(" ")}
      >
        {/* pr-7 holds this line clear of the attention mark, which sits on it, on
            every card — so the rates line up down the column whether or not a
            card carries a mark. The line below runs the full width. */}
        {/* items-center, and every child in the same 20px line box: the rate and
            the attention mark then centre on the same axis, which is what makes
            them read as one line. Aligning the rate on the name's baseline
            instead drops it visibly below the mark, because it is set smaller. */}
        <span className="flex items-center justify-between gap-4 pr-7">
          <span className="text-[15px] leading-5 font-medium tracking-[-0.005em]">
            {label.label}
          </span>
          {rate && (
            <span className="shrink-0 text-[12px] leading-5 text-ink-faint tabular-nums">
              {rate}
            </span>
          )}
        </span>
        {/* The arrow says which way the dependency runs, so the line reads as one
            statement — "Large invoice ← Invoice + Large amount" — rather than as a
            row of loose names beneath a title. */}
        {references.length > 0 && (
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            <span aria-hidden="true" className="text-[12px] leading-4 text-ink-faint">
              ←
            </span>
            {references.map((reference) => (
              <Reference
                key={reference.name}
                name={reference.name}
                suggested={reference.suggested}
                group={reference.group}
              />
            ))}
          </span>
        )}

        <span
          className="mt-2 block text-[11.5px] leading-4 text-ink-faint tabular-nums"
          title={lastAt ?? undefined}
        >
          {last}
        </span>
      </button>

      <AttentionMark attention={label.attention} />
    </div>
  );
}

/**
 * A detection label a derived label is built from. Carries the colours of the
 * panel that label lives in rather than the card's own: it names a label from
 * another column, and that is the whole point of it being here. Each chip simply
 * inherits the family of the label it names, whatever that turns out to be — a
 * derived label may draw on any number of detection labels in any combination of
 * roles, so nothing here assumes a shape.
 *
 * Required labels all have to match before the derived label is even evaluated;
 * recommended ones are context, present or not. Dashed says the difference, and
 * the native tooltip says it in words — the detail panel spells it out in full.
 */
const CHIPS: Record<LabelGroupKey, string> = {
  category: "border-category-rule bg-category",
  attribute: "border-attribute-rule bg-attribute",
  derived: "border-derived-rule bg-derived",
  "no-role": "border-rule bg-white/60",
};

function Reference({
  name,
  suggested = false,
  group,
}: {
  name: string;
  suggested?: boolean;
  group: LabelGroupKey;
}) {
  return (
    <span
      title={suggested ? "Recommended" : "Required"}
      className={[
        "rounded-md border px-2 py-0.5",
        CHIPS[group],
        "text-[11px] leading-4 text-ink-soft",
        suggested ? "border-dashed" : "",
      ].join(" ")}
    >
      {name}
    </span>
  );
}
