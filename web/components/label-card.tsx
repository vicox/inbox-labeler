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
};

/**
 * One label, on either side. Detection and derived cards differ only in surface
 * colour: the panel a card sits in already says which kind it is, so making the
 * cards themselves differ would say it twice — and a derived label's activity is
 * read the same way as a detection label's.
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
  onEnter,
  onLeave,
  onOpen,
}: Props) {
  const detection = label.type === "detection";
  const required = label.required_labels ?? [];
  const recommended = label.recommended_labels ?? [];

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
        {(required.length > 0 || recommended.length > 0) && (
          <span className="mt-2 flex flex-wrap gap-1.5">
            {required.map((name) => (
              <Reference key={name} name={name} />
            ))}
            {recommended.map((name) => (
              <Reference key={name} name={name} suggested />
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
 * A detection label a derived label is built from. Carries the detection panel's
 * own colours rather than the card's: it names a label from the other column, and
 * that is the whole point of it being here.
 *
 * Required labels all have to match before the derived label is even evaluated;
 * recommended ones are context, present or not. Dashed says the difference, and
 * the native tooltip says it in words — the detail panel spells it out in full.
 */
function Reference({ name, suggested = false }: { name: string; suggested?: boolean }) {
  return (
    <span
      title={suggested ? "Recommended" : "Required"}
      className={[
        "rounded-md border border-detection-rule bg-detection px-2 py-0.5",
        "text-[11px] leading-4 text-ink-soft",
        suggested ? "border-dashed" : "",
      ].join(" ")}
    >
      {name}
    </span>
  );
}
