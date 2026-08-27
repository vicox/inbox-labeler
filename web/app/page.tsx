import { LegalLinks } from "@/components/legal";
import { PolicyGraph } from "@/components/policy-graph";

export default function Home() {
  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-10 border-b border-rule pb-5 sm:mb-14">
        <div className="flex items-baseline gap-4">
          <h1 className="font-display text-[19px] tracking-[-0.01em]">Inbox Labeler</h1>
          <p className="text-[12.5px] text-ink-faint">Teach your AI what matters.</p>
        </div>

        {/*
          The closed beta keeps each user's labels in Postgres behind /mcp, while
          this page reads the local data/labels.json the project grew out of. Both
          are wanted — the local workflow still uses the file — so the difference
          is explained rather than hidden, and without it the empty state below
          reads as lost data to someone who just created labels over MCP.
        */}
        <p className="mt-3 max-w-2xl text-[12.5px] leading-relaxed text-ink-faint">
          Closed beta — used through an MCP client at /mcp. Labels created there are not shown on
          this page yet: this view reads the local data/labels.json.
        </p>
      </header>

      <PolicyGraph />

      {/*
        Linked rather than merely present: Google's OAuth branding step asks for a
        home page, a privacy policy and terms on the app's own domain, and a page
        nothing points at is one nobody — reviewer or user — is expected to find.
      */}
      <footer className="mt-14 border-t border-rule pt-5 sm:mt-20">
        <LegalLinks />
      </footer>
    </main>
  );
}
