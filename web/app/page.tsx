import { PolicyGraph } from "@/components/policy-graph";

export default function Home() {
  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-10 flex items-baseline gap-4 border-b border-rule pb-5 sm:mb-14">
        <h1 className="font-display text-[19px] tracking-[-0.01em]">Inbox Labeler</h1>
        <p className="text-[12.5px] text-ink-faint">The labels your mail is read against.</p>
      </header>

      <PolicyGraph />
    </main>
  );
}
