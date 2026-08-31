"use client";

import { useEffect, useRef } from "react";

import type { Label } from "@/lib/policy";

type Props = {
  label: Label;
  /** Derived labels this detection label feeds. Empty for a derived label. */
  feeds: string[];
  onClose: () => void;
};

/**
 * Everything the policy already says about one label, and nothing else. Reading
 * only — labels are still written through the CLI and the agents.
 */
export function LabelDetail({ label, feeds, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const requires = label.required_labels ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex cursor-pointer items-start justify-center overflow-y-auto bg-scrim px-5 py-[10vh]"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label.label}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-xl cursor-default rounded-2xl border border-rule bg-paper p-9 outline-none"
      >
        <div className="flex items-start justify-between gap-6">
          <div>
            <h2 className="font-display text-[27px] leading-tight tracking-[-0.01em]">
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
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 -mt-1 cursor-pointer rounded-md px-2 py-1 text-[13px] text-ink-soft transition hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Close
          </button>
        </div>

        {requires.length > 0 && <Related title="Requires" names={requires} />}
        {feeds.length > 0 && <Related title="Feeds" names={feeds} />}

        <Section title="Instruction">
          <p className="text-[14px] leading-relaxed text-ink/85">{label.instruction}</p>
        </Section>
      </div>
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
