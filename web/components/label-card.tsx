"use client";

import type { Label } from "@/lib/policy";
import { AttentionMark } from "./attention-mark";

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
  onEnter: () => void;
  onLeave: () => void;
  onOpen: () => void;
  cardRef: (element: HTMLElement | null) => void;
  /** Extra space above, used to line a derived card up with its inputs. */
  offset?: number;
};

/**
 * One label, on either side. Detection and derived cards differ only in surface
 * colour: the panel a card sits in already says which kind it is, so making the
 * cards themselves differ would say it twice — and a derived label's activity is
 * read the same way as a detection label's.
 *
 * The name sits at the left and the rate at the right of the same line, with
 * when it last matched underneath. The attention mark is further right again, and
 * holds elements of its own rather than being part of the card's button, because
 * it takes hover and focus separately from the card.
 */
export function LabelCard({
  label,
  dimmed,
  lit,
  rate,
  last,
  lastAt,
  onEnter,
  onLeave,
  onOpen,
  cardRef,
  offset,
}: Props) {
  const detection = label.type === "detection";

  return (
    // Positioned, and after the threads in the DOM, so a thread passing by tucks
    // behind the card instead of drawing across its face. The relationship hover
    // sits here rather than on the button so that it covers the right-hand margin
    // too, and keeps running while the pointer is on the attention mark.
    <div
      ref={cardRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      style={offset ? { marginTop: offset } : undefined}
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
          "block w-full rounded-lg border px-5 py-4 text-left",
          "min-h-[62px] transition-shadow duration-200 ease-out",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
          detection
            ? "border-detection-rule bg-detection-card"
            : "border-derived-rule bg-derived-card",
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
        <span
          className="mt-1 block text-[11.5px] leading-4 text-ink-faint tabular-nums"
          title={lastAt ?? undefined}
        >
          {last}
        </span>
      </button>

      <AttentionMark attention={label.attention} />
    </div>
  );
}
