"use client";

import type { Label } from "@/lib/policy";
import { AttentionMark } from "./attention-mark";

type Props = {
  label: Label;
  /** Dimmed because something else is focused and this label is unrelated to it. */
  dimmed: boolean;
  /** Lit because it is focused, or connected to whatever is. */
  lit: boolean;
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
 * cards themselves differ would say it twice.
 *
 * The name on the left says which label this is; the right-hand margin says what
 * the label does, which for now is the attention it carries. That margin holds
 * elements of its own rather than being part of the card's button, because they
 * take hover and focus separately from the card.
 */
export function LabelCard({
  label,
  dimmed,
  lit,
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
          "flex w-full items-center rounded-lg border px-5 py-4 text-left",
          "min-h-[62px] transition-shadow duration-200 ease-out",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
          detection
            ? "border-detection-rule bg-detection-card"
            : "border-derived-rule bg-derived-card",
          lit ? "shadow-[0_1px_0_rgba(28,26,23,0.10)]" : "shadow-none",
        ].join(" ")}
      >
        <span className="pr-8 text-[15px] leading-snug font-medium tracking-[-0.005em]">
          {label.label}
        </span>
      </button>

      <AttentionMark attention={label.attention} />
    </div>
  );
}
