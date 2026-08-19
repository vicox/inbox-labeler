"use client";

import type { Label } from "@/lib/policy";

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
  /** Extra space above, used to line a derived card up with its first input. */
  offset?: number;
};

/**
 * One label, on either side. Detection and derived cards differ only in surface
 * colour: the panel a card sits in already says which kind it is, so making the
 * cards themselves differ would say it twice.
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
    <button
      ref={cardRef}
      type="button"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      onClick={onOpen}
      style={offset ? { marginTop: offset } : undefined}
      aria-label={`${label.label}, ${label.type} label`}
      className={[
        // Positioned, and after the threads in the DOM, so a thread passing by
        // tucks behind the card instead of drawing across its face.
        "relative flex w-full items-center rounded-lg border px-5 py-4 text-left",
        "min-h-[62px] transition duration-200 ease-out",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        detection
          ? "border-detection-rule bg-detection-card"
          : "border-derived-rule bg-derived-card",
        dimmed ? "opacity-35" : "opacity-100",
        lit ? "-translate-y-px shadow-[0_1px_0_rgba(28,26,23,0.10)]" : "shadow-none",
      ].join(" ")}
    >
      <span className="text-[15px] leading-snug font-medium tracking-[-0.005em]">
        {label.label}
      </span>
    </button>
  );
}
