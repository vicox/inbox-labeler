"use client";

import { useState } from "react";

import type { Attention } from "@/lib/label-graph";

/**
 * What a label asks of the reader, as a mark rather than a word: a star for the
 * ones worth looking at, a struck-through eye for the ones that ask nothing.
 * `normal` gets nothing at all — it is the ordinary case, and marking it would
 * put attention in competition with the relationship the page is about.
 *
 * Lucide's `star` and `eye-off`, inlined. Two icons do not earn a dependency.
 */
const MARKS = {
  high: {
    title: "High attention",
    description: "Emails with this label deserve your attention.",
  },
  none: {
    title: "No attention",
    description: "Emails with this label don't need your attention.",
  },
} as const;

export function AttentionMark({ attention }: { attention: Attention }) {
  const [open, setOpen] = useState(false);

  if (attention === "normal") return null;
  const mark = MARKS[attention];

  return (
    // Sits in the card's right-hand margin as a sibling of the card button, not
    // inside it: it takes focus of its own, and focusable content nested in a
    // button is neither valid nor reliably reachable. Pointer events on this
    // element do not disturb the card's own hover, which is handled one level up
    // and so keeps running while the pointer is in here.
    <span
      tabIndex={0}
      role="img"
      aria-label={`${mark.title}. ${mark.description}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      // top-4 / h-5 put it on the same line as the label name and the rate,
      // rather than in the middle of a card that is now two lines tall.
      className="absolute top-4 right-5 flex h-5 cursor-help items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
    >
      {attention === "high" ? <Star /> : <EyeOff />}
      {open && <Tooltip title={mark.title} description={mark.description} />}
    </span>
  );
}

/** Opens upwards, so it covers the cards above rather than the ones below. */
function Tooltip({ title, description }: { title: string; description: string }) {
  return (
    <span
      role="tooltip"
      className="absolute right-0 bottom-full z-20 mb-2.5 w-56 rounded-lg border border-rule bg-paper px-3.5 py-3 text-left shadow-[0_2px_10px_rgba(28,26,23,0.07)]"
    >
      <span className="block text-[12.5px] font-medium">{title}</span>
      <span className="mt-1 block text-[12.5px] leading-snug text-ink-soft">{description}</span>
    </span>
  );
}

function Star() {
  return (
    <svg viewBox="0 0 24 24" className="block h-[18px] w-[18px] text-thread-lit" fill="currentColor">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="block h-[18px] w-[18px] text-ink-faint"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}
