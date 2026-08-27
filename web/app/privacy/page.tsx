import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LegalPage, OperatorAddress } from "@/components/legal";
import { operator } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Privacy Policy — Inbox Labeler",
  description: "What the hosted Inbox Labeler closed beta processes, and what it does not.",
};

export default function Privacy() {
  // Without a named operator this is not a privacy policy, so it is not served.
  const op = operator();
  if (!op) notFound();

  return (
    <LegalPage title="Privacy Policy">
      <section>
        <h2>Who is responsible</h2>
        <p>
          Inbox Labeler is operated by a private individual, not a company. The controller within the
          meaning of the GDPR is:
        </p>
        <OperatorAddress operator={op} />
        <p>
          For any question about this policy or your data, including a request to delete it, write to{" "}
          <a href={`mailto:${op.email}`}>{op.email}</a>.
        </p>
      </section>

      <section>
        <h2>What this policy covers</h2>
        <p>
          Inbox Labeler is currently a <strong>free, invitation-only closed beta</strong>. Access is
          limited to a list of e-mail addresses configured by the operator; any other Google account is
          refused after signing in, and receives nothing from us.
        </p>
        <p>
          This policy covers the hosted service at inboxlabeler.com — its web pages, the sign-in
          endpoints under <code>/oauth</code>, and the MCP endpoint at <code>/mcp</code>.
        </p>
        <p>
          It does not cover the Inbox Labeler skills that read your mailbox. Those run in{" "}
          <strong>your own environment</strong> and talk to Google directly. What they may submit to
          the hosted service is the <strong>names of the labels an e-mail matched</strong> and{" "}
          <strong>that e-mail&rsquo;s own timestamp</strong>, which is what the match counts are
          aggregated from. No e-mail content, sender, recipient, subject, message or thread identifier
          and no attachment passes through the hosted service.
        </p>
      </section>

      <section>
        <h2>Signing in with Google</h2>
        <p>
          Signing in redirects you to Google. We request exactly two scopes, <code>openid</code> and{" "}
          <code>email</code>. We do not request <code>profile</code>, so we receive no name and no
          picture.
        </p>
        <p>
          <strong>Received, and only for the moment of signing in.</strong> Google&rsquo;s token
          response, the identity token inside it, and a Google access token that comes with that
          response. The Google access token is <strong>not used and not stored</strong> — the hosted
          service holds no Gmail or Drive permission that it could be used for. The identity token is
          validated and then discarded; it is not stored either.
        </p>
        <p>
          <strong>Used.</strong> The identity token&rsquo;s signature, issuer, audience and expiry are
          checked against Google&rsquo;s published keys, and a value we generated for this one sign-in
          (a nonce) must match, so that a token issued for a different session cannot be replayed into
          yours. From its contents we use three things: the <strong>subject</strong>,
          Google&rsquo;s stable and opaque identifier for your account; your{" "}
          <strong>e-mail address</strong>; and <strong>whether Google verified that address</strong>{" "}
          — if it has not, the sign-in is refused.
        </p>
        <p>
          <strong>Stored.</strong> Only the subject, as your user key, prefixed to record which
          provider it came from. It survives you changing your e-mail address, which is exactly why it
          is used instead of the address.
        </p>
        <p>
          <strong>Your e-mail address is not stored.</strong> It is used once to check whether you are
          on the invitation list, and then discarded: it is not written to the database, not contained
          in any token we issue, and never visible to an MCP client. One thing follows from this and is
          worth stating plainly — the <strong>invitation list itself</strong> is a list of addresses the
          operator entered deliberately, and it remains stored in the hosting provider&rsquo;s
          environment configuration for as long as the beta uses it. Your address is not kept because
          you signed in; it is kept because the operator invited you.
        </p>
        <p>
          Google itself learns that your account signed in to Inbox Labeler, when, and from which IP
          address — your browser contacts Google directly. That processing is Google&rsquo;s own and is
          described in Google&rsquo;s privacy policy.
        </p>
        <p>
          Legal basis: the operator relies on Art. 6(1)(b) GDPR — providing the service you asked to
          use.
        </p>
      </section>

      <section>
        <h2>What we store</h2>
        <p>
          <strong>Your labels.</strong> The label text, its type and attention level, the free-text{" "}
          <code>instruction</code> in which you describe how it should decide, the references between
          labels, and the times a label was created and last changed. The instruction is stored as you
          wrote it apart from surrounding whitespace, which is removed.
        </p>
        <p>
          <strong>Match statistics.</strong> For each label, a count per calendar day and the timestamp
          of the newest e-mail it matched. Nothing per message: no subject, sender, recipient, body,
          message or thread identifier, and no attachment. There is no table with one row per e-mail,
          and the database has nowhere to put any of it.
        </p>
        <p>
          <strong>Sign-in and connection data.</strong> For each MCP client that registers itself: its
          identifier, the redirect addresses it names, the name it gives for itself, and when it
          registered. For a sign-in in progress: the client it belongs to, the scope and resource
          requested, an expiry time, and hashed values that bind the flow to the browser it started in.
          For an issued grant: the user it belongs to, its scope and resource, an expiry time, and — for
          refresh tokens — which family it belongs to, whether an individual token has been
          spent, and whether the family has been revoked.
        </p>
        <p>
          Authorization codes, refresh tokens and the browser binding are stored{" "}
          <strong>only as hashes</strong>; the values themselves are held by your client or your
          browser, not by us. Inbox Labeler&rsquo;s own access tokens are signed and{" "}
          <strong>not stored on the server at all</strong>.
        </p>
        <p>
          <strong>Rate-limit counters.</strong> The two endpoints that anyone can call are counted per
          caller, so that a stranger cannot fill the database with requests. The caller is identified by
          a keyed hash of their IP address; the address itself is not written to our database.
        </p>
        <p>
          Legal basis: the operator relies on Art. 6(1)(b) GDPR for labels, statistics and sign-in
          data, and on Art. 6(1)(f) GDPR for the rate-limit counters, the legitimate interest being to
          keep the service available and to prevent abuse.
        </p>
      </section>

      <section>
        <h2>What we do not do</h2>
        <ul>
          <li>No analytics, no tracking, no profiling, no advertising, no newsletter.</li>
          <li>
            No third-party scripts. The fonts are served from this domain, so your browser makes no
            request to Google Fonts.
          </li>
          <li>
            The hosted service does not read your Gmail and does not write to Google Drive. It holds no
            Gmail or Drive scope, and no code that could call either API.
          </li>
          <li>No payments, and therefore no payment data.</li>
          <li>We do not sell your data and do not pass it on for anyone else&rsquo;s purposes.</li>
        </ul>
      </section>

      <section>
        <h2>Cookies and browser storage</h2>
        <p>
          <strong>One short-lived cookie per authorization attempt.</strong> It is set when the approval
          page is shown and removed as soon as you answer it. It holds a random value that ties your
          approval to the browser the page was shown in, which is what stops someone else&rsquo;s
          website from submitting an approval on your behalf.
        </p>
        <p>
          Its attributes are <code>HttpOnly</code>, <code>SameSite=Strict</code> and{" "}
          <code>Path=/oauth</code>, with <code>Secure</code> set on the hosted HTTPS deployment, and it
          lives for ten minutes. We consider it strictly necessary within the meaning of § 25(2) TDDDG,
          and accordingly no consent banner is shown.
        </p>
        <p>
          We set no other cookies, and we use no local storage, session storage or IndexedDB in your
          browser.
        </p>
      </section>

      <section>
        <h2>Service providers</h2>
        <p>
          We use two providers, and treat both as processors under Art. 28 GDPR on the data processing
          terms they provide:
        </p>
        <ul>
          <li>
            <strong>Vercel</strong> — hosting. As the hosting layer it receives the connection and
            request data of every visit, including your IP address, and keeps platform logs of its own.
            The operator has configured the application&rsquo;s server functions to run in{" "}
            <strong>Frankfurt, Germany</strong>. Static files such as stylesheets and fonts are
            delivered through Vercel&rsquo;s content delivery network, which serves them from
            locations worldwide — they are not restricted to Frankfurt.
          </li>
          <li>
            <strong>Neon</strong> — the PostgreSQL database, which the operator has configured in{" "}
            <strong>Frankfurt, Germany</strong>. Neon receives database connections from the
            application and stores the records described above. It does not receive your
            browser&rsquo;s connection, and therefore not your IP address by that route.
          </li>
        </ul>
        <p>
          These regions are deployment settings the operator has verified in the providers&rsquo;
          dashboards; they are not established by the published source code. Both providers belong to
          groups with entities outside the EU and use subprocessors of their own; their documentation
          describes this and the safeguards they apply.
        </p>
        <p>
          Our own application writes no request logs and stores no IP address in clear text.{" "}
          <strong>That is not the same as saying no IP address is processed.</strong> As with any
          hosted service, the hosting layer necessarily sees it.
        </p>
      </section>

      <section>
        <h2>How long we keep things</h2>
        <p>
          The periods below are <strong>validity periods</strong> — how long a record can still be
          used. They are not a promise that it has been physically removed at that moment:
        </p>
        <ul>
          <li>a sign-in in progress is valid for ten minutes</li>
          <li>an authorization code is valid for sixty seconds, and is deleted when it is used</li>
          <li>
            an Inbox Labeler access token is valid for one hour, and is not stored on the server at all
          </li>
          <li>a refresh token, and the family it belongs to, is valid for thirty days</li>
          <li>
            rate-limit counters are kept in windows — ten minutes for sign-ins, an hour for client
            registrations — and a counter row becomes eligible for removal about a day after it was
            last written
          </li>
        </ul>
        <p>
          Expired rows are cleaned up opportunistically, as a side effect of later requests, rather than
          by a scheduled job. An expired record is unusable from the moment it expires, but may remain
          physically present in the database for some time after that.
        </p>
        <p>
          <strong>Your labels, your match statistics and your client registrations</strong> are subject
          to a policy of the operator rather than a rule in the software: they are{" "}
          <strong>intended to be kept until the closed beta ends</strong>, and the operator will delete
          them then, or earlier on a valid request. The application does not delete them by itself, and
          performs no automatic deletion at the end of the beta.
        </p>
        <p>
          Our providers keep backups and point-in-time history for a retention window of their own. Data
          that has been deleted here therefore remains recoverable inside their systems until that
          window passes; deleting it here does not remove it from a provider&rsquo;s backups at the same
          moment.
        </p>
      </section>

      <section>
        <h2>Deleting your data</h2>
        <p>
          Write to <a href={`mailto:${op.email}`}>{op.email}</a>. During this beta, deletion is carried
          out by hand rather than by a button in the product. We act without undue delay and, as a rule,
          within one month.
        </p>
      </section>

      <section>
        <h2>Your rights</h2>
        <p>
          Where applicable and subject to the statutory conditions, you have the right to access your
          data (Art. 15 GDPR), to have it corrected (Art. 16) or erased (Art. 17), to have its
          processing restricted (Art. 18), to receive it in a portable form (Art. 20), and to object to
          processing based on legitimate interests (Art. 21).
        </p>
        <p>
          You may also lodge a complaint with a supervisory authority (Art. 77 GDPR), in particular in
          the Member State of your habitual residence, your place of work, or the place of the alleged
          infringement.
        </p>
      </section>

      <section>
        <h2>Changes to this policy</h2>
        <p>
          Inbox Labeler is a beta and changes while it runs. If what we process changes, this page
          changes with it, and the date at the top says when it last did.
        </p>
      </section>
    </LegalPage>
  );
}
