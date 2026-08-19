"use client";

import type { Connection } from "@/lib/policy";

/** A card's measured box, in the coordinates the threads are drawn in. */
export type Anchor = { left: number; right: number; top: number; height: number; y: number };

type Props = {
  connections: Connection[];
  anchors: Map<string, Anchor>;
  /** Indices into `connections` to draw at full strength. Empty means nothing is focused. */
  lit: Set<number>;
  width: number;
  height: number;
};

/**
 * The threads from detection labels to the derived labels that require them.
 *
 * Each one leaves the right edge of its detection card and arrives at the left
 * edge of its derived card, so every curve lives in the gutter between the two
 * panels and never crosses a card. Resting weight is deliberately near the edge
 * of visible: twenty-five labels drawn boldly at once is a thicket, and the
 * point is that hovering one label picks its own threads out of it.
 */
export function Connections({ connections, anchors, lit, width, height }: Props) {
  if (!width || !height) return null;
  const focused = lit.size > 0;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className="pointer-events-none absolute inset-0"
    >
      {connections.map((connection, index) => {
        const from = anchors.get(connection.from);
        const to = anchors.get(connection.to);
        if (!from || !to) return null;

        const x1 = from.right;
        const x2 = to.left;
        const reach = (x2 - x1) * 0.5;
        const path = `M ${x1} ${from.y} C ${x1 + reach} ${from.y}, ${x2 - reach} ${to.y}, ${x2} ${to.y}`;
        const isLit = lit.has(index);

        return (
          <path
            key={`${connection.from}→${connection.to}`}
            d={path}
            fill="none"
            stroke={isLit ? "var(--color-thread-lit)" : "var(--color-thread)"}
            strokeWidth={isLit ? 1.75 : 1.15}
            strokeLinecap="round"
            opacity={isLit ? 1 : focused ? 0.1 : 0.6}
            className="transition-[opacity,stroke-width] duration-200 ease-out"
          />
        );
      })}
    </svg>
  );
}
