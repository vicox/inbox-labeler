import type { Label } from "@/lib/label-list";
import { BackToLabels } from "./signed-in";

type Props = {
  label: Label;
  /** Derived labels this detection label feeds. Empty for a derived label. */
  feeds: string[];
};

/**
 * One label's screen: everything already known about it, and nothing else.
 *
 *     ← Labels
 *
 *     Invoices
 *     Detection · category · attention high
 *
 *     REQUIRES / FEEDS      the labels on the other side of it, when there are any
 *     INSTRUCTION           what it is told to decide, in the user's words
 *
 * Reached from its card in the label lists, and left by the link back to them or the
 * browser's own back. Reading only — labels are written through the MCP tools,
 * never from here — so the heading has nothing beside it.
 */
export function LabelView({ label, feeds }: Props) {
  const requires = label.required_labels ?? [];

  return (
    <div className="mx-auto max-w-xl">
      <BackToLabels />

      <article className="mt-6">
        <h2 className="font-display text-[27px] leading-tight tracking-[-0.01em] break-words">
          {label.label}
        </h2>
        {/* The role rides the kind, because it refines it: "Detection · category"
            reads as one statement about what this label is. A detection label
            from before roles existed simply says "Detection", which is the truth
            about it — nothing is guessed to fill the gap. */}
        <p className="mt-1.5 text-[13px] text-ink-soft">
          {label.type === "detection" ? "Detection" : "Derived"}
          {label.type === "detection" && label.role && (
            <span className="text-ink-faint"> · {label.role}</span>
          )}
          <span className="text-ink-faint"> · attention {label.attention}</span>
        </p>

        {requires.length > 0 && <Related title="Requires" names={requires} />}
        {feeds.length > 0 && <Related title="Feeds" names={feeds} />}

        <Section title="Instruction">
          <p className="text-[14px] leading-relaxed text-ink/85">{label.instruction}</p>
        </Section>
      </article>
    </div>
  );
}

function Related({ title, names }: { title: string; names: string[] }) {
  return (
    <Section title={title}>
      <ul className="flex flex-wrap gap-2">
        {names.map((name) => (
          <li
            key={name}
            className="rounded-md border border-rule px-2.5 py-1 text-[13px] text-ink/80"
          >
            {name}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7 border-t border-rule pt-5">
      <h3 className="mb-2.5 text-[11px] tracking-[0.13em] text-ink-faint uppercase">{title}</h3>
      {children}
    </section>
  );
}
