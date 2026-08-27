import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LegalPage, OperatorAddress } from "@/components/legal";
import { operator } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Impressum — Inbox Labeler",
  description: "Anbieterkennzeichnung nach § 5 DDG.",
};

/**
 * In German, because it satisfies a German legal requirement and is read by
 * people applying German law. The rest of the site is English, so the page says
 * why it is not.
 *
 * It states what applies and nothing else. A list of fields that do not apply,
 * with reasons, is not a disclosure — it is an explanation nobody asked for, and
 * it invites a reader to check reasoning that is not theirs to check.
 */
export default function Impressum() {
  const op = operator();
  if (!op) notFound();

  return (
    <LegalPage title="Impressum">
      <section>
        <p className="!mt-0 text-ink-faint">
          This page is in German because it fulfils a requirement of German law (§ 5 DDG). The{" "}
          <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms of Use</a> are in English.
        </p>
      </section>

      <section>
        <h2>Angaben gemäß § 5 DDG</h2>
        <OperatorAddress operator={op} />
      </section>

      <section>
        <h2>Kontakt</h2>
        <p>
          E-Mail: <a href={`mailto:${op.email}`}>{op.email}</a>
        </p>
      </section>
    </LegalPage>
  );
}
