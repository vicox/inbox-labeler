import { LegalLinks } from "@/components/legal";
import { PolicyGraph } from "@/components/policy-graph";

export default function Home() {
  return (
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="mb-10 border-b border-rule pb-5 sm:mb-14">
        <div className="flex items-baseline gap-4">
          <h1 className="font-display text-[19px] tracking-[-0.01em]">Inbox Labeler</h1>
          <p className="text-[12.5px] text-ink-faint">Teach your AI how to organize your inbox.</p>
        </div>

        {/*
          How the beta is reached, and the whole of what this page has to say when
          there is no local policy to draw. Where the state actually lives is not a
          visitor's problem: they need to know how to connect, not which file this
          view happens to read.
        */}
        <p className="mt-3 max-w-2xl text-[12.5px] leading-relaxed text-ink-faint">
          Closed beta — connect Inbox Labeler through your MCP client.
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
