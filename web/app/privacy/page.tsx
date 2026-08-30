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
          refused after signing in, and receives nothing from us. If no list is configured, the hosted
          service admits <strong>nobody</strong> rather than everybody — it refuses every sign-in until
          the operator has named the invited addresses.
        </p>
        <p>
          This policy covers the hosted service at inboxlabeler.com — its web pages including the
          signed-in view of your labels at <code>/</code>, the website&rsquo;s own sign-in endpoints
          under <code>/auth</code>, the endpoints an MCP client is authorized through under{" "}
          <code>/oauth</code>, and the MCP endpoint at <code>/mcp</code>.
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
          <strong>Stored.</strong> The subject, as your user key, prefixed to record which provider it
          came from. It survives you changing your e-mail address, which is exactly why it is used
          instead of the address. If you signed in on this website rather than from an MCP client,
          your e-mail address is stored as well, on that browser session and only there — see{" "}
          <strong>Your browser session</strong> below.
        </p>
        <p>
          <strong>Where your e-mail address goes.</strong> It is used to check whether you are on the
          invitation list. It is never contained in any token we issue and never visible to an MCP
          client. When an <strong>MCP client</strong> is authorized, that is all that happens to it:
          it is checked and discarded, and not written to the database. When <strong>you sign in to
          this website</strong>, it is additionally written to the row that represents your browser
          session, because the site shows you which Google account its labels belong to and because
          the invitation list is re-checked against it on every page you load. It is held for as long
          as that session is, and goes when the session does — but <strong>losing access and the row
          being deleted are two different moments</strong>, and only the first is immediate. Signing
          out deletes it there and then. An expired session stops working the instant it expires and
          its row is removed later; being removed from the invitation list blocks the session on its
          next request, and where the list has been emptied or misconfigured altogether the refusal
          happens before any deletion does. <strong>How long we keep things</strong>, below, sets
          out which case is which.
        </p>
        <p>
          One thing follows from this and is worth stating plainly — the{" "}
          <strong>invitation list itself</strong> is a list of addresses the operator entered
          deliberately, and it remains stored in the hosting provider&rsquo;s environment
          configuration for as long as the beta uses it. Your address is not kept there because you
          signed in; it is kept because the operator invited you.
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
          identifier, the redirect addresses it names, the name it gives for itself, when it
          registered, and when an authorization was last started for it. For a sign-in in progress: the client it belongs to, the scope and resource
          requested, an expiry time, and hashed values that bind the flow to the browser it started in.
          For an issued grant: the user it belongs to, its scope and resource, an expiry time, and — for
          refresh tokens — which family it belongs to, whether an individual token has been
          spent, and whether the family has been revoked.
        </p>
        <p>
          <strong>Your browser session.</strong> If you sign in on this website, one row per signed-in
          browser: your user key, the e-mail address Google verified, when the session began and when
          it expires. Nothing else — no name, no picture, no Google token, no record of which pages you
          looked at. While a sign-in is in progress there is also a short-lived row holding only the
          values that tie it together: a one-time value we require in Google&rsquo;s reply, a proof key
          for the exchange with Google, an expiry time, and a hash of the cookie that ties the sign-in
          to the browser that started it. An MCP client&rsquo;s authorization in progress holds the same
          kind of values, and a hash of the cookie tying the trip to Google to the browser that gave
          the approval.
        </p>
        <p>
          Authorization codes, refresh tokens, session cookies and the browser bindings are stored{" "}
          <strong>only as hashes</strong>; the values themselves are held by your client or your
          browser, not by us. Inbox Labeler&rsquo;s own access tokens, which only MCP clients get, are
          signed and <strong>not stored on the server at all</strong> — which is also why a browser
          session is stored: so that signing out can end it, rather than only asking your browser to
          forget it.
        </p>
        <p>
          <strong>Rate-limit counters.</strong> The three endpoints that anyone can call — client
          registration, an MCP client&rsquo;s authorization request, and this website&rsquo;s sign-in —
          are counted per caller, so that a stranger cannot fill the database with requests. Where the
          hosting platform has established the caller&rsquo;s IP address, the caller is identified by a
          keyed one-way hash of it; the address itself is not written to our database. Where it has not,
          the request is counted in a single shared counter and no address is involved at all.
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
        <h2>Cookies</h2>
        <p>
          <strong>Four kinds of cookie</strong>, and every one of them holds a random value and nothing
          else. There is no information inside a cookie — no address, no name, no identifier of yours —
          only a value that has to match a stored record for the request to mean anything. We consider
          all four strictly necessary within the meaning of § 25(2) TDDDG, being required to provide the
          sign-in and the signed-in pages you asked for, and accordingly no consent banner is shown.
        </p>
        <p>
          On the hosted service all four are <code>HttpOnly</code> (no script can read them),{" "}
          <code>Secure</code> (sent only over HTTPS), <code>Path=/</code>, carry no{" "}
          <code>Domain</code>, and are named with the <code>__Host-</code> prefix — which is what tells
          your browser to refuse a cookie of the same name set by anything but this exact site. On a
          developer&rsquo;s own machine the prefix and <code>Secure</code> are dropped, because a
          browser rejects a <code>Secure</code> cookie over plain <code>http</code>; nothing else about
          them differs.
        </p>
        <ul>
          <li>
            <strong>
              <code>__Host-il_consent_…</code> — one per authorization attempt by an MCP client.
            </strong>{" "}
            Set when the approval page is shown and removed as soon as you answer it. It ties your
            approval to the browser the page was shown in, which is what stops someone else&rsquo;s
            website from submitting an approval on your behalf. <code>SameSite=Strict</code>, ten
            minutes.
          </li>
          <li>
            <strong>
              <code>__Host-il_provider_…</code> — one per approved authorization, for the trip to
              Google.
            </strong>{" "}
            Set when you approve an MCP client and removed when you come back from Google. It ties the
            rest of that authorization to the same browser, so an approval given in your browser cannot
            be completed in someone else&rsquo;s. <code>SameSite=Lax</code>, ten minutes.
          </li>
          <li>
            <strong>
              <code>__Host-il_login_…</code> — one per sign-in to this website.
            </strong>{" "}
            Set when you press sign in and removed when you come back from Google. It ties the sign-in
            to the browser that started it. <code>SameSite=Lax</code>, ten minutes.
          </li>
          <li>
            <strong>
              <code>__Host-il_session</code> — your signed-in session.
            </strong>{" "}
            Set when a sign-in completes and removed when you sign out. It is what the site reads
            to know whose labels to show. <code>SameSite=Lax</code>, seven days.
          </li>
        </ul>
        <p>
          The first three carry, in their name, a short one-way digest of a value belonging to the flow
          they are part of. That is only so two of them can be in progress at once without interfering;
          the digest identifies the flow, never you, and it is not what makes a request authentic — the
          value <em>inside</em> the cookie is, and it is compared against a stored hash.
        </p>
        <p>
          We set no other cookies, and we use no local storage, session storage or IndexedDB in your
          browser. None of these cookies is used for analytics, tracking or profiling — see below.
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
          <li>a sign-in in progress, either kind, is valid for ten minutes</li>
          <li>
            a signed-in browser session is valid for seven days from the moment you signed in. Two
            different things can end it, and they are worth telling apart.{" "}
            <strong>Access stops</strong> the moment the session is no longer valid: when you sign out,
            when you sign in again in that browser, when the seven days pass, or when the invitation
            list no longer admits your address — which is re-checked on <em>every</em> request the
            session makes, so a change by the operator reaches you on your next page load.{" "}
            <strong>The stored row is a separate question.</strong> Signing out, signing in again, and a
            request that finds your address removed from a list that still names other people each
            delete it there and then. But a session whose browser simply never comes back, and a session
            refused because the list has been emptied or misconfigured altogether, are refused without
            the row necessarily being removed at that moment — it stops working immediately either way,
            and is deleted later, in the opportunistic way described below
          </li>
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
          <strong>A client registration</strong> also records <strong>when it was last used</strong>.
          It is set to the moment of registration when the client registers, and refreshed each time an
          authorization is started for it — starting one is the only thing counted as use; a client
          being looked up is not. So a client that registered and was never authorized still carries a
          time, its registration time, and its clock runs from there. That timestamp exists so a
          registration nobody ever came back for can be cleaned up rather than kept for ever.
        </p>
        <p>
          A registration becomes <strong>eligible for deletion</strong> once ninety days have passed
          since it was last used. Deletion itself is opportunistic rather than scheduled: eligible
          registrations are removed the next time any client registers, so a row may remain for some
          time after it became eligible. A client that is still in use never becomes eligible, and one
          that has lapsed registers itself again the next time it is used.
        </p>
        <p>
          <strong>Your labels and your match statistics</strong> are subject to a policy of the
          operator rather than a rule in the software: they are{" "}
          <strong>intended to be kept until the closed beta ends</strong>, and the operator will delete
          them then, or earlier on a valid request. The application does not delete them by itself, and
          performs no automatic deletion at the end of the beta.
        </p>
        <p>
          Our providers operate backups and point-in-time recovery of their own, on terms they document
          and we do not set. Deleting data here therefore does not necessarily remove it from a
          provider&rsquo;s backups at the same moment. For how long a copy may persist there, their own
          documentation is the authority; we make no promise of our own about it.
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
