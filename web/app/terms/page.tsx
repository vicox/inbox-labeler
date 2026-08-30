import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LegalPage } from "@/components/legal";
import { operator } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Terms of Use — Inbox Labeler",
  description: "The terms for the free, invitation-only Inbox Labeler closed beta.",
};

export default function Terms() {
  const op = operator();
  if (!op) notFound();

  return (
    <LegalPage title="Terms of Use">
      <section>
        <h2>What Inbox Labeler is right now</h2>
        <p>
          Inbox Labeler is a <strong>free closed beta</strong>, operated by a private individual. It is a
          test version, not a finished product, and nothing here is sold: there is no charge, no
          subscription and no paid plan.
        </p>
      </section>

      <section>
        <h2>Who may use it</h2>
        <p>
          Use is limited to people who have been invited. Access is granted per e-mail address, and the
          operator decides which addresses are on the list and may add or remove one at any time. With
          no list configured, the service admits nobody.
        </p>
        <p>
          Removing an address stops that account from signing in again, and closes the signed-in
          website to a browser that is already signed in as soon as it loads another page.
          Credentials already issued to an MCP client may remain usable until they expire or are
          revoked by hand — so for those, removal prevents future sign-in rather than ending every
          active connection at that instant.
        </p>
      </section>

      <section>
        <h2>Availability</h2>
        <p>
          There is no promise that the service is available, that it keeps working, or that it keeps
          working the same way. It may be unavailable, changed, or discontinued at any time and without
          notice — that is what a beta is. Please do not build anything on it that you cannot afford to
          lose, and do not treat it as the only place something is stored.
        </p>
        <p>Liability is governed by the applicable statutory provisions.</p>
      </section>

      <section>
        <h2>Your use of it</h2>
        <p>
          You are responsible for how you use Inbox Labeler and for what you put into it. Please do not
          use it unlawfully, do not attempt to reach another person&rsquo;s data, and do not try to
          disrupt or overload the service.
        </p>
      </section>

      <section>
        <h2>The instruction field</h2>
        <p>
          A label carries an <code>instruction</code> — free text in which you describe how the label
          should decide. It is stored as you wrote it, apart from surrounding whitespace.
        </p>
        <p>
          <strong>
            Please do not put special categories of personal data in it — for example anything about
            health, beliefs or political views — and do not put other people&rsquo;s personal details in
            it.
          </strong>{" "}
          A description of the kind of mail you mean is enough, and it does not need names. The operator
          has no way to prevent what you type, which is why it is asked for here.
        </p>
      </section>

      <section>
        <h2>Your data</h2>
        <p>
          What is processed, and for how long, is described in the{" "}
          <a href="/privacy">Privacy Policy</a>. In short: content you create is intended to be kept
          until the closed beta ends and deleted by the operator then, or earlier on request.
        </p>
      </section>

      <section>
        <h2>Ending it</h2>
        <p>
          You can stop using Inbox Labeler whenever you like, and ask for your data to be deleted. The
          operator may withdraw access at any time, in particular if these terms are not respected or
          when the closed beta ends.
        </p>
      </section>

      <section>
        <h2>Applicable law and contact</h2>
        <p>
          German law applies. If you are a consumer, the mandatory consumer protection rules of your
          country of residence remain unaffected.
        </p>
        <p>
          The operator is named in the <a href="/impressum">Impressum</a>. For anything about these
          terms, write to <a href={`mailto:${op.email}`}>{op.email}</a>.
        </p>
      </section>
    </LegalPage>
  );
}
