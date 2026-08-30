import type { Label } from "@/lib/inbox/labels";

/**
 * The labels page's own pieces.
 *
 * Server components throughout, and deliberately: everything on this page is
 * already known when the HTML is written, so there is nothing for a client
 * component to do here and no reason for the labels to travel to the browser as
 * data as well as as text. It also means the page holds no fetch, no state and no
 * effect that could be pointed at a different user's labels.
 *
 * The palette is the home page's, from `app/globals.css`: a detection label sits
 * on peach and a derived one on mint, which is the one distinction the eye should
 * get for free. Nothing here shows how often a label matched — that is the graph's
 * subject, and this page's subject is the policy.
 */

/**
 * Every label this user has defined, in the order the store returns them —
 * alphabetically, ignoring case, which is `get_labels`' order too. This page and
 * an MCP client looking at one account should not have to reconcile two
 * orderings of the same policy.
 */
export function LabelList({ labels }: { labels: readonly Label[] }) {
  if (labels.length === 0) {
    return (
      <Notice>
        <span className="block text-ink">No labels yet</span>
        <span className="mt-1.5 block text-[12.5px] text-ink-faint">
          Ask your MCP client to set up Inbox Labeler, or to create a label, and it appears here.
        </span>
      </Notice>
    );
  }

  return (
    <ul className="space-y-3">
      {labels.map((label) => (
        <LabelEntry key={label.label} label={label} />
      ))}
    </ul>
  );
}

/**
 * One label, showing every field a label has.
 *
 * The fields are `lib/inbox/labels.ts`' `Label` and nothing besides: the text, the
 * type, the attention level, the instruction, and — for a derived label — the two
 * reference lists. A derived label always carries both lists, empty ones included,
 * because that is what the store returns and an empty list is a fact about the
 * label rather than a missing field.
 */
function LabelEntry({ label }: { label: Label }) {
  const detection = label.type === "detection";
  const surface = detection
    ? "border-detection-rule bg-detection-card"
    : "border-derived-rule bg-derived-card";

  return (
    <li className={`rounded-lg border px-5 py-4 ${surface}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[15px] leading-5 font-medium tracking-[-0.005em]">{label.label}</h3>
        <p className="text-[12px] leading-5 text-ink-soft">
          {label.type}
          <span className="text-ink-faint"> · attention {label.attention}</span>
        </p>
      </div>

      <p className="mt-2 text-[13.5px] leading-[1.6] whitespace-pre-line text-ink-soft">
        {label.instruction}
      </p>

      {/* Only a derived label has these, and then it has both. */}
      {label.type === "derived" && (
        <dl className="mt-3 space-y-1 text-[12.5px]">
          <References term="required_labels" labels={label.required_labels ?? []} />
          <References term="recommended_labels" labels={label.recommended_labels ?? []} />
        </dl>
      )}
    </li>
  );
}

/**
 * One reference list, named by its field rather than by a prettier phrase.
 *
 * The field names are the ones `get_labels` returns and the ones an MCP client
 * asks with, so using them here means the page and the tool describe the policy in
 * one vocabulary. An empty list says "none" rather than disappearing: for a derived
 * label, having no required labels is a property worth being able to read off the
 * page.
 */
function References({ term, labels }: { term: string; labels: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="font-mono text-ink-faint">{term}</dt>
      <dd className={labels.length ? "text-ink-soft" : "text-ink-faint"}>
        {labels.length ? labels.join(", ") : "none"}
      </dd>
    </div>
  );
}

/**
 * The one shape this page says anything in that is not a label: an empty policy,
 * or something that could not be read.
 *
 * The landing page's own notice is a bare centred paragraph in open space, which
 * works there because it stands in for a whole graph. Here it sits in a list of
 * bordered cards, so it takes the card's frame — otherwise a message about labels
 * reads as page furniture rather than as the answer where a label would have been.
 */
export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-rule px-5 py-10 text-center text-[14px] text-ink-soft">
      {children}
    </div>
  );
}
