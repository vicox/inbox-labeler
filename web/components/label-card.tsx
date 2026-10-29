"use client";

import Link from "next/link";

import type { Label } from "@/lib/label-list";
import { labelHref } from "@/lib/web/screens";
import { AttentionMark } from "./attention-mark";

type Props = {
  label: Label;
  /** About how often it matches, beside the name — null when there is no rate. */
  rate: string | null;
  /** When it last matched, under the name, or "Never matched". */
  last: string;
  /** The exact timestamp behind `last`, for the native tooltip. */
  lastAt?: string | null;
  /**
   * The detection labels a derived label is built from; empty on a detection
   * card. `suggested` marks the ones offered as context rather than required.
   */
  references: { name: string; suggested?: boolean }[];
};

/**
 * One label in its list — mint for a derived label, warm for everything else.
 * Its role does not come into it: a category, an attribute and a label with
 * neither look the same here, and the label's own screen is what tells them apart.
 *
 * The whole card is one link to that screen (`labelHref`), so a press anywhere on
 * it opens the label, and it can be opened in a new tab like any other link. Not
 * prefetched: a label's screen is rendered per request for its owner, so there is
 * nothing worth fetching before somebody asks for it.
 *
 * The name sits at the left and the rate at the right of the same line, with
 * when it last matched underneath. A derived label also names the detection
 * labels it is built from, between the two. The attention mark follows the name,
 * and holds elements of its own rather than being part of the card's link,
 * because it takes hover and focus separately from the card.
 */
export function LabelCard({ label, rate, last, lastAt, references }: Props) {
  // `normal` carries no mark; see AttentionMark.
  const marked = label.attention !== "normal";

  return (
    // Positioned, so the attention mark can sit over the name line. The hover
    // sits here rather than on the link so that it keeps running while the
    // pointer is on the mark.
    <div className="group relative transition duration-200 ease-out hover:-translate-y-px focus-within:-translate-y-px">
      <Link
        href={labelHref(label.label)}
        prefetch={false}
        aria-label={`${label.label}, ${label.type} label`}
        className={[
          "block w-full cursor-pointer rounded-lg border px-5 py-4 text-left",
          label.type === "derived"
            ? "border-derived-rule bg-derived-card"
            : "border-label-rule bg-label-card",
          "min-h-[62px] transition-shadow duration-200 ease-out",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
          "shadow-none group-hover:shadow-[0_1px_0_rgba(28,26,23,0.10)] group-focus-within:shadow-[0_1px_0_rgba(28,26,23,0.10)]",
        ].join(" ")}
      >
        {/* The rate sits flush right. A card with an attention mark holds room for
            it after the name — the same width and margin as the mark — so the name
            wraps here exactly as the copy laid over it does; see below. The line
            below runs the full width. */}
        {/* items-center, and every child in the same 20px line box: the rate and
            the attention mark then centre on the same axis, which is what makes
            them read as one line. Aligning the rate on the name's baseline
            instead drops it visibly below the mark, because it is set smaller. */}
        <span className="flex items-center justify-between gap-4">
          <span className="text-[15px] leading-5 font-medium tracking-[-0.005em]">
            {label.label}
            {marked && <span aria-hidden="true" className="ml-1.5 inline-block w-[18px]" />}
          </span>
          {rate && (
            <span className="shrink-0 text-[12px] leading-5 text-ink-faint tabular-nums">
              {rate}
            </span>
          )}
        </span>
        {references.length > 0 && (
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            {references.map((reference) => (
              <Reference
                key={reference.name}
                name={reference.name}
                suggested={reference.suggested}
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
      </Link>

      {/* The mark cannot be inside the link, so it sits in a copy of the
          link's box laid over it: the same border, padding and name line, with
          the name and rate invisible, so the mark lands just after the name
          wherever the name wraps. The name is positioned so the mark's tooltip
          opens from it. Only the mark takes the pointer; the rest passes it
          through to the card underneath. */}
      {marked && (
        <span className="pointer-events-none absolute inset-0 border border-transparent px-5 py-4">
          <span className="flex items-center justify-between gap-4">
            <span className="relative text-[15px] leading-5 font-medium tracking-[-0.005em]">
              <span className="invisible">{label.label}</span>
              <AttentionMark attention={label.attention} />
            </span>
            {rate && (
              <span className="invisible shrink-0 text-[12px] leading-5 tabular-nums">
                {rate}
              </span>
            )}
          </span>
        </span>
      )}
    </div>
  );
}

/**
 * A detection label a derived label is built from. Carries the warm surface of a
 * detection label rather than the mint of the card it sits on: it names a label
 * in the detection list, and that is the whole point of it being here.
 *
 * Required labels all have to match before the derived label is even evaluated;
 * recommended ones are context, present or not. Dashed says the difference, and
 * the native tooltip says it in words — the label's screen lists what it requires.
 */
function Reference({ name, suggested = false }: { name: string; suggested?: boolean }) {
  return (
    <span
      title={suggested ? "Recommended" : "Required"}
      className={[
        "rounded-md border border-label-rule bg-label px-2 py-0.5",
        "text-[11px] leading-4 text-ink-soft",
        suggested ? "border-dashed" : "",
      ].join(" ")}
    >
      {name}
    </span>
  );
}
