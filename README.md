# Inbox Labeler

## What is Inbox Labeler?

Inbox Labeler turns a mailbox full of unlabelled mail into one that carries categories you
defined — the ones that matter to you, not a fixed set someone else chose. You describe, in
plain language, the aspects of a message you care about; Claude reads your mail and detects
which of those aspects are present, applying each one as a Gmail label.

A label names the aspect of a message it detects, how to detect it, and the Gmail label to
apply when that aspect is present.

Two things make this more than a labelling script. First, some things only matter in
combination: an invoice, on its own, is routine, but a large invoice is worth a second look. A
Derived Label lets you say that directly, building `Large invoice` from `Invoices` and
`Large amount` rather than writing a new rule from scratch.
[A concrete example](#a-concrete-example) walks through exactly how.

Second, meaning alone isn't the whole story. Not every label deserves the same reaction, so
every label also carries an **Attention** level — what it asks of you, separately from what it
means: star a message, mark it read, or leave it alone. [The model](#the-model) covers what
each level does in full.

Nothing runs on its own. You ask, and something happens — see
[Automating it](#automating-it) if you would rather it happened hourly.

## A concrete example

Take three labels from the starter set
[`inbox-labeler-setup`](skills/inbox-labeler-setup/SKILL.md) creates. Each one starts from two
directly observed facts, combines them into something more useful, and then shows Attention as
the separate, final step:

```text
Email
  ↓
Detection labels:  Invoices, Large amount
  ↓
Derived label:     Large invoice
  ↓
Attention:         high
```

```text
Email
  ↓
Detection labels:  Delivery, Imminent
  ↓
Derived label:     Delivery arriving soon
  ↓
Attention:         high
```

```text
Email
  ↓
Detection labels:  Marketing, Newsletter
  ↓
Derived label:     Promotional newsletter
  ↓
Attention:         none
```

`Invoices` and `Large amount` are each detected on their own, directly from the email — an
invoice is an invoice whether or not the amount is large, and a large amount can appear outside
an invoice too. Only once both are present does `Large invoice` add anything: a label naming
exactly what the combination means.

What Inbox Labeler does about it next — starring the message, here — comes from that label's
own Attention, a separate decision. The same pattern repeats for a delivery that's due
imminently and for a newsletter that turns out to be promotional, whose `none` Attention only
marks it read once it's a day old.

[The model](#the-model) covers detection labels, derived labels and Attention in full, and
[Getting started](#getting-started) shows how to build on this example yourself.

## The model

`type` says how a label decides whether it applies. There are two, and both produce a Gmail
label the same way — only the decision differs:

| Type | Question it answers |
| --- | --- |
| `detection` | *What can I directly observe in this email?* |
| `derived` | *Given the email and the detection labels that matched, what does this mean?* |

**Detection labels recognise facts. Derived labels interpret those facts.**

### Detection labels

A detection label reads the email directly and decides. Here is what one looks like in full:

```json
{
  "label": "Delivery",
  "type": "detection",
  "role": "category",
  "attention": "normal",
  "instruction": "The message is a shipping or delivery status update for an order (e.g. 'out for delivery', 'delivered', 'shipped', tracking updates from a carrier or retailer like Amazon, DHL, UPS)."
}
```

**`role` says what kind of fact the label found**, and every newly created detection label must
state one:

| Role | The question it answers | Examples |
| --- | --- | --- |
| `category` | *What kind or domain of email is this?* | `Delivery`, `Invoice`, `Newsletter`, `Travel` |
| `attribute` | *What does this email contain, indicate, or require?* | `Action required`, `Deadline`, `Large amount`, `Marketing` |

The test is which question the instruction is deciding, not what part of speech the name is:
`Large amount` is an attribute because an amount is something an email *contains* rather than a
kind of email it *is*. Neither role is exclusive — one message may match several categories and
several attributes — and **the role does not affect matching**: each detection label is still
decided on its own, by its own instruction. It changes how a matched fact reads, not whether it
matched.

A detection label modelled before roles existed has **no `role` field**, and that is a supported
state rather than a broken one: it is read, matched and referenced exactly as any other. The
missing field means nobody has decided yet — nothing is guessed from the label's name or
instruction, nothing is backfilled, and editing something else about such a label leaves the gap
alone. Settling it is one explicit change, made with the user; see
[`inbox-labeler-manage`](skills/inbox-labeler-manage/SKILL.md).

Derived labels have no role at all, and are refused one — a derived label is already an
interpretation of detection facts, so there is no kind-of-fact for it to be.

Each label also carries an **attention** level — what it asks of you; see
[Attention](#attention) below.

`Invoices`, `Newsletter`, `Question` and `Large amount` are detection labels.

### Derived labels

A derived label names what a combination of detection labels means — the way `Large invoice`,
`Delivery arriving soon` and `Promotional newsletter` did [above](#a-concrete-example). To
decide that, it evaluates the email together with the detection labels that already matched,
using them as structured context. [Attention](#attention), covered next, is a separate decision
built on top of that meaning. [Working with labels](#working-with-labels) covers exactly how a
derived label names the detection labels it builds on.

### Attention

Labels describe what was detected and what it means. **Attention** says what it asks of you —
and it is the only thing that lets Inbox Labeler touch your mailbox rather than just annotate
it.

| Attention | What it does to the mail |
| --- | --- |
| `none` | marked read once the message is 24h old |
| `normal` | *(the default)* nothing at all |
| `high` | starred, and it stays starred |

Attention is **not** a label. It is computed per message from the labels that are on it, and the
**highest-priority one wins** — `high` > `none` > `normal`. One `high` label makes the message
`high`; failing that, one `none` label makes it `none`; otherwise it stays `normal`.

`normal` comes last because it is the absence of a request, not a request to be left alone: a
`Newsletter` label at `none` on the same message as an `Invoices` at `normal` still gets the mail
marked read, because `none` is the only thing either label actually asked for. A message with no
labels comes out `normal`, so it is left alone. The behaviours above are fixed and not
configurable.

**Color says what kind of label it is, and nothing else.** Detection Labels are warm and Derived
Labels mint — two families, from the one mapping the processing skill keeps, in tiles from Gmail's
own palette. A Detection Label's role plays no part: a Category, an Attribute and one whose role
nobody has settled are all the same yellow, because all three are the same kind of label. Role is
how a label is modelled and how the website groups it, not something a color says. Attention plays
no part either — a label is the same color whether it asks for `high` or `none`. Attention is
still part of a label's own configuration, and still what decides whether a message gets starred
or marked read; it is simply not what a Gmail label's color encodes. The website uses the same two
families, though the hex values differ because the palettes do.

Color is purely presentation: it never feeds back into what a label detects, and processing never
recolors a message — only the Gmail label itself, and only Detection and Derived Labels get one;
the reserved system labels never do. It's set the moment a Gmail label is created, and since a
label's type never changes it stays as it is from then on, so no color is ever chosen or edited by
hand.

Inbox Labeler resolves each label to a Gmail label inside its own `IL/` namespace whenever it
talks to Gmail — `IL/` itself is never part of a label's identity and is never stored anywhere.
[How processing works](#how-processing-works) covers the full namespace, including the two
reserved system labels.

## Getting started

**New to Inbox Labeler? Say "set up Inbox Labeler".** The
[`inbox-labeler-setup`](skills/inbox-labeler-setup/SKILL.md) skill creates a small, coherent
starter set — eleven detection labels, four derived labels built on top of them, and the
attention each asks for. It is production-quality and usable as-is, but meant as a demonstration
of the core modelling concepts rather than a one-size-fits-all configuration: adjust the
instructions to your own mail afterwards, through
[`inbox-labeler-manage`](skills/inbox-labeler-manage/SKILL.md). Setup only ever runs into an
empty account, and it creates nothing if labels are already there.

Then say things like "add a label for invoices" or "list my labels" to manage them, and one of
these two to label mail — there is no third thing to remember, because recording what matched
happens inside processing:

| Say | What it does |
| --- | --- |
| **"process my inbox"** | classifies unread inbox mail that hasn't been processed yet, labels it, and records what matched |
| **"apply attention"** | stars and marks read already-labelled mail, from the attention its labels carry |

Both use Claude's Gmail tools when they are connected — see
[How processing works](#how-processing-works) for exactly how the two relate. Want the whole run? Say
**"process my inbox, update matches, then apply attention."**

Want it to happen without asking every time? A recurring Claude task can say "process my inbox,
update matches, then apply attention" on a schedule — see [Automating it](#automating-it) for the setup.

*The rest of this README is the technical reference.*

## Working with labels

### What a label is

> A user-defined way to detect an aspect of a message that is interesting to the user.

That aspect can be as broad or as narrow as you like. A `Social` label for everything from a
social platform is perfectly good; so is `Connection` for connection requests specifically.
You can have both. Your choice of labels *is* the model — Inbox Labeler has no opinion on how
fine-grained they should be.

What matters is how labels behave together:

- **Independent.** Each label is evaluated on its own. Whether it triggers depends on two
  things only: the message, and its own instruction.
- **Any number may trigger.** A message triggers as many labels as have their aspect present
  — none, one, several, or all of them.
- **Every trigger produces a Gmail label.** Each label whose aspect is present contributes
  its Gmail label to the message.
- **Additive, not alternatives.** For a given message the outcome is the complete set of
  triggered labels, and the Gmail labels applied are exactly that set.

A LinkedIn connection request, for example, may carry several aspects at once: it is social
mail, and it is a connection request. If you keep labels for both, the message carries
`IL/Social` and `IL/Connection` together — and the strongest Attention among them, not any
single label, determines what Gmail does next.

The same holds at any breadth. Someone with `Invoices`, `Stripe` and `Reminder` labels sees all
three land on a Stripe invoice reminder. Someone who prefers a single `Billing` label covering
the same ground gets that one Gmail label instead. Both work the same way: every label that
triggers adds its Gmail label, and none of them displaces another.

`label` is the label's **only identifier** — there is no separate name and no technical id.
It is a readable phrase, spaces and all, and it is what other labels reference and what
`get`, `update` and `delete` address. Labels are unique ignoring case, and lookups are
case-insensitive too, so `get "delivery arriving soon"` finds it. Leading and trailing spaces
are trimmed and inner runs of whitespace collapse to one; punctuation and digits are fine.

Two labels are **not** yours: `processed` and `no-match` are reserved system labels, and the
lowercase spelling is the convention that marks them as internal. Your labels are readable
phrases — `Delivery`, `Large amount`, `Delivery arriving soon` — and keep their spelling
exactly as you write it. See [System labels](#system-labels).

### Detection vs derived

You describe what you want and Inbox Labeler works out the model — you never pick a type.
Usually that is one detection label. When your request names several things that are each worth
detecting on their own, though, you get a detection label per concept plus one derived label
combining them, and you are told so in a line or two before anything is created:

> Create a label for invoices with unusually large amounts that should be reviewed.

becomes `Invoices` and `Large amount` as detection labels, with `Large invoice`
derived on top — so the two observations are yours to reuse in other labels later. When the
parts are only ever wanted together — "login codes and password reset links" — it stays one
detection label with the detail in its instruction. Naming several things is not by itself a
reason to split; being useful apart is. The simplest model that keeps the pieces reusable wins.

### Required labels

A derived label names the detection labels it builds on:

```json
{
  "label": "Travel preparation",
  "type": "derived",
  "instruction": "Travel that asks the recipient to prepare something before or during the trip.",
  "required_labels": ["Travel", "Action required"],
  "recommended_labels": []
}
```

- **`required_labels`** — all of them must have matched, or the derived label isn't evaluated
  for that message. This is the gate.
- **`recommended_labels`** — context. Included in the prompt when they matched; when they
  didn't, the derived label is still evaluated.

### Renaming

**Renaming carries the references with it.** `update "Large amount" --label "Big amount"`
rewrites every reference to it in the same write, so the store is never left dangling.
Renaming onto a label that already exists is rejected.

### References

References are the exact label text of an existing detection label — spaces included. Both
fields hold labels (`Large amount`, not `IL/Large amount`), both may be empty, and both may
only point at detection labels — there is no chaining from one derived label to another. The
email is still available during evaluation; the detection labels are structured context that
makes the decision easier and more consistent.

Two more rules keep the references honest:

- **A label's type is immutable.** You cannot turn a detection label into a derived one, or the
  reverse — create a new label instead.
- **A referenced detection label cannot be deleted.** If a derived label names it in
  `required_labels` or `recommended_labels`, the delete is rejected and tells you which derived
  label is in the way. Nothing is rewritten for you: drop the reference or delete the derived
  label first.

## How processing works

`process` labels; `attention` acts on those labels. Two commands, two jobs.

Both work on **individual messages**, not threads, and both are scoped to **unread inbox mail
only** — archived and read mail are never touched. Their scopes are mirror images and never
overlap:

| | Scope | Per run | What it writes |
| --- | --- | --- | --- |
| **`process`** | unread inbox mail **without** `IL/processed` | at most **10** | `IL/` labels, match counts |
| **`attention`** | unread inbox mail **with** `IL/processed` | no limit | `STARRED`, `UNREAD` |

### process

A run handles at most ten messages, fewer if fewer are eligible. Anything beyond the tenth keeps
its place, because it never got `IL/processed` either — so run it again to work through a
backlog, and each run continues where the last one stopped with no cursor to maintain.

Each message goes through two stages:

```text
Email
  ↓
Detection labels      each decided independently against the email
  ↓
IL/no-match            when no detection label matched
  ↓
Derived labels        each decided from the email + the detection labels that matched
  ↓
IL/processed          last, always
```

| Detection outcome | Gmail labels applied |
| --- | --- |
| at least one detection label triggered | every triggered business label |
| nothing triggered | `IL/no-match` |

Then the derived stage runs: a derived label whose `required_labels` didn't all match is skipped,
and each one that does trigger adds its business label. `IL/processed` goes on last, so an
interrupted run leaves the message to be picked up again, and a failure on one message is
reported while the run continues with the rest.

**`process` only ever adds labels.** Nothing is removed — not Gmail's own labels, not the ones
Inbox Labeler applied earlier. Unread is a scope filter only; `process` never changes it.

**Labelling only moves forward.** A message keeps the labels it was given. Editing an
instruction changes what *new* mail receives, and deleting a label stops it being applied in
future — neither reaches back to mail already processed, because no command revisits it. A Gmail
label already on a message therefore stays where it is: a configuration change performs no
cleanup of its own.

### attention

Run it by saying **"apply attention"**. It reads the `IL/` labels already on a message, works out
the effective level, and sets `STARRED` or clears `UNREAD` accordingly. It never looks at the
email, never classifies anything, and never adds or removes an `IL/` label. See
[Attention](#attention) for the levels and their timings.

### System labels

| Gmail label | Meaning |
| --- | --- |
| `IL/processed` | Inbox Labeler has finished the pipeline for this message. |
| `IL/no-match` | No **detection** label matched this message. |

They serve different purposes. `IL/processed` records **processing state** — that the work
happened. `IL/no-match` records the **outcome of detection** — that no detection label matched.
A message that was processed and matched nothing carries both; a message that matched something
carries `IL/processed` alongside its business labels. `IL/no-match` and detection business labels
never coexist on a message — the outcome is one or the other. Derived labels don't affect
`IL/no-match`, since it is decided before they are evaluated.

`processed` and `no-match` are **reserved system labels** — internal implementation detail, not
something a user models. Inbox Labeler rejects them on create, on rename and on delete, in any
casing, so `Processed` and `NO-MATCH` are refused too.

`IL/no-match` is what makes an empty result visible. Without it, a message that matched
nothing looks exactly like a message that was never processed once you stop looking at
`IL/processed` — with it, you can search `label:IL/no-match` to see what your current labels
are missing, which is the fastest way to spot a gap worth a new label.

### The `IL/` namespace

**Inbox Labeler owns the entire `IL/` namespace.** Every Gmail label starting with `IL/` is
Inbox Labeler's to create, apply and remove — the namespace *is* its model, expressed as Gmail
labels. Treat it as internal: don't create or maintain `IL/` labels by hand in Gmail, because
Inbox Labeler assumes everything there is its own. The way to get a new `IL/` label is to add a
label.

Because the namespace belongs to Inbox Labeler rather than to any individual label, it never
appears in configuration. Labels store the label itself and Inbox Labeler resolves it to the
**Gmail** label whenever it creates, applies, removes, compares or reports one. Detection and
Derived Labels resolve exactly the same way — nothing in Gmail distinguishes one from the
other, both are just business labels:

| Kind | Stored label | Gmail label |
| --- | --- | --- |
| Detection | `Delivery` | `IL/Delivery` |
| Derived | `Delivery arriving soon` | `IL/Delivery arriving soon` |
| System | `processed` | `IL/processed` |

The boundary holds in both directions: **Inbox Labeler never modifies a Gmail label outside
`IL/`.** Everything out there belongs to Gmail or to you — `INBOX`, `UNREAD`, `STARRED`,
`IMPORTANT`, `CATEGORY_*`, and every label you made yourself. Those are read, never written.

### Automating it

Optional, and no part of the implementation.

If you want it to happen regularly, set up a **recurring Claude task** with a prompt like:

```text
Process my inbox, update matches, then apply attention.
```

Hourly is a reasonable cadence: `process` handles up to ten messages per run, so an hourly task
keeps up with roughly 240 messages a day and works steadily through a backlog. The order
matters — `process` first, so the mail it just labelled falls into `attention`'s scope in the
same run rather than waiting an hour.

Everything the task needs must already be in place: the Gmail connector connected, and label
labels already in the account for step zero to load. A run with no labels stops and reports
instead of doing anything.

## Persistence

Inbox Labeler's state lives in the **Inbox Labeler MCP server**, one set of labels and one match
history per authenticated Google account. There is nothing local to read and nothing to load
first: an empty list is a normal starting state for a new account, not an error, and the labels
are reached only through the MCP tools, which validate before writing.

Because the account is established by the access token rather than named in a call, there is no
argument anywhere that says whose labels to read — see [Per-user state](#per-user-state) for how
that is enforced, and [Where hosted state lives](#where-hosted-state-lives) for the tables.

Nothing needs to be set up to start. A new account has no labels and none are invented for it —
`get_labels` answers with an empty list, and the starter set arrives only when somebody asks for
it, from [`inbox-labeler-setup`](skills/inbox-labeler-setup/SKILL.md).

## What matched, and how often

The match history counts how often each label has matched, and is the one thing Inbox Labeler
keeps after a run. It is written only by `record_matches` and read only by `get_matches`; label
definitions never hold a count.

**It records that a label matched, not what it matched.** Per label it holds the newest email
timestamp it has seen and a count per calendar day — nothing more. No subject, no sender, no
recipients, no message or thread id, nothing about an attachment, nothing that could lead back
to a message:

```json
{
  "Invoice": {
    "last_matched_at": "2026-08-20T10:12:00Z",
    "daily_matches": {
      "2026-08-18": 2,
      "2026-08-19": 1,
      "2026-08-20": 3
    }
  }
}
```

The timestamp is **the email's own**, never the moment of the run, so labelling a year-old
message raises that year-old day's count. `last_matched_at` only ever moves forward: the newest
email a label has matched, not the last time anything was written. Days with no matches are not
stored, and a label that has never matched is simply absent rather than present and zero.

Recording is part of processing — see [How processing works](#how-processing-works). A rename
carries the counts across and a delete removes them, in the same write, so the labels and their
counts never disagree about which labels exist.

## Remote MCP (development)

Inbox Labeler exposes an authenticated remote MCP endpoint alongside the web UI, so
an MCP client — Claude, ChatGPT, the MCP Inspector — can connect to Inbox Labeler as
a signed-in user:

```text
inboxlabeler.com
├── /                    the web UI
└── /mcp                 the MCP endpoint, OAuth-protected
```

A connected client can manage the labels and read the match history of whichever
Inbox Labeler user authenticated — one owner per Google account, established by the
access token rather than named in any call:

| Tool | |
| --- | --- |
| `get_labels` | every label this user has defined |
| `create_label` | define one, detection or derived |
| `update_label` | change one, including renaming it |
| `delete_label` | remove one, and its match history with it |
| `get_matches` | how often each label has matched |
| `record_matches` | record that an email matched these labels |
| `get_server_info` | that the endpoint is reachable, and who is calling |

**Processing a mailbox is not here.** Nothing in the endpoint reads mail, classifies
it, or applies attention: the MCP holds configuration and match counts and has no
access to Gmail. That mailbox work belongs to the focused agent skills, which pair
this endpoint with a Gmail connector — `inbox-labeler-process` classifies new unread
inbox mail and `inbox-labeler-attention` acts on what it has already labelled, while
`inbox-labeler-setup` and `inbox-labeler-manage` use these tools for configuration
alone. These tools are the state those runs read and write, which is why
`record_matches` takes the labels that matched rather than an email.

Every request is attributed to one user before a tool is reached:

```text
MCP client
  ↓  401 from /mcp, carrying a pointer to the metadata below
Protected Resource Metadata      /.well-known/oauth-protected-resource/mcp
  ↓  names the authorization server
Authorization Server Metadata    /.well-known/oauth-authorization-server
  ↓  register, then authorize with PKCE
Consent                          this client, named, before anything is forwarded
  ↓
Google sign-in                   which Google account you are, and nothing else
  ↓  authorization code → access token, audience-bound to /mcp
/mcp                             a request attributed to one Inbox Labeler user
  ↓
that user's labels and matches   and nobody else's: see Per-user state below
```

Inbox Labeler is its own OAuth 2.1 authorization server for its own endpoint, and
delegates only the question of *who the user is* to Google. That keeps the token
bound to a resource Inbox Labeler owns, while leaving passwords, resets and account
recovery to an identity provider that already knows the account whose mail is being
labelled.

The consent step is not decoration. Inbox Labeler holds a single Google application
shared by every client that registers, and Google remembers a user's approval of it —
so once you have approved it, a later forward could complete from your existing Google
session without showing you anything. Anyone who registered a client could then walk
you through the endpoint and collect a code in silence. The MCP authorization
specification requires exactly this mitigation, and the page names the client and the
host your approval would send a code to.

### Configuration

Copy [`web/.env.example`](web/.env.example) to `web/.env.local` and fill it in. That
file documents each variable in full; in short:

| Variable | |
| --- | --- |
| `PUBLIC_ORIGIN` | the public origin every OAuth and MCP URL is derived from — scheme and host, no path. Optional in development, where it defaults to `http://localhost:3000`; **required in production** |
| `OAUTH_SIGNING_SECRET` | what access tokens are signed with. At least 32 bytes — `openssl rand -base64 48` |
| `GOOGLE_CLIENT_ID` | a Google OAuth 2.0 "Web application" client |
| `GOOGLE_CLIENT_SECRET` | its secret |
| `DATABASE_URL` | Postgres, holding the OAuth flow state and each user's labels and matches. **Required in production**; unset in development, which uses an embedded Postgres instead |
| `ALLOWED_EMAILS` | comma-separated addresses allowed to sign in. **Required in production**, where an unset, empty or blank list admits nobody; optional in development, where it admits anyone — see [Who may sign in](#who-may-sign-in) |
| `DEV_DATABASE_DIR` | development only: where that embedded database keeps its files. Unset means in-memory |

The Google client needs **two** authorised redirect URIs, both derived from
`PUBLIC_ORIGIN`, because two different flows come back from Google:

| Redirect URI | Comes back from |
| --- | --- |
| `<origin>/oauth/callback` | an **MCP client** being authorized |
| `<origin>/auth/callback` | a **person signing in** to the website |

Locally that is `http://localhost:3000/oauth/callback` and
`http://localhost:3000/auth/callback`. Register both: the one you forget fails with
Google's `redirect_uri_mismatch`, and nothing else says why.

The scopes are `openid email` — the address is read to check the access list below,
and `profile` is not requested, so Inbox Labeler never learns a name or a picture.

`.env.local` is gitignored. `.env.example` holds names and never values.

### Who may sign in

Signing in requires a Google account, and Google will vouch for anybody's.
`ALLOWED_EMAILS` is the whole of Inbox Labeler's access control, and how a private
beta is closed. It is **required in production**, and what "no list" means depends
on where the code is running:

| `ALLOWED_EMAILS` | Production | Development |
| --- | --- | --- |
| configured | only the listed addresses | only the listed addresses |
| unset, empty, blank, or only commas | **nobody** — the deployment refuses every sign-in | any Google account with a verified email address |

Every way of naming no addresses is the same thing and gets the same answer: unset,
`""`, `" "`, `","`, `" , , "` all normalise to an empty list.

To close it, list the addresses, comma-separated:

```bash
ALLOWED_EMAILS=georg@example.com,tester@example.com
```

Matching ignores case and surrounding space on both sides, so
`Georg@Example.COM ` and `georg@example.com` are the same person. An address must
also be one Google has marked verified — an unverified one is an address the
account holder typed rather than proved, so a list checked against it would be a
list anyone could join.

The check sits at the identity boundary, right after Google establishes who signed
in and before Inbox Labeler issues anything. A rejected account never receives an
authorization code, let alone a token — it authenticates with Google
successfully and comes away with nothing.

```text
Google callback  →  verify identity  →  check the list  →  AuthenticatedUser
```

**The address decides access, not identity.** The user is still the Google
subject — `google:<the verified sub>` — which survives them changing their address,
so a beta tester who renames their account keeps their labels. The address is never
the tenant key, never in a token we issue, and never in an MCP result.

Where it *is* stored is one place, and only for the website: a **browser session row**
keeps the verified address for as long as that session lasts, because the site
shows you which Google account it is displaying and because the list above is
re-checked against it on every request the session makes. An **MCP client's**
authorization stores no address at all — it is checked against the list and dropped.

#### Why production fails closed

A closed beta must not become public because a variable was renamed, blanked, or
lost on the way into an environment. So in production, no list means **nobody**:
the deployment raises a configuration error, refuses the requests that need it, and
writes the reason to its own log — exactly as it does for a missing signing secret
or a missing database.

It refuses rather than answering "you are not on the list", and the difference
matters. There *is* no list, so that answer would be a lie told to somebody who may
well be invited, and it would leave you with a deployment that looks healthy, admits
nobody, and says nothing about why. A configuration fault names the cause where the
operator can read it.

Two consequences worth knowing before you set it:

- **Removing the last address closes the deployment**, rather than opening it. That
  is the point, but it means the variable is not a place to empty out temporarily.
- **A signed-in browser loses access on its next page load.** The list is
  re-checked on every request rather than only at sign-in, so an operator's change
  reaches people who are already signed in.

Outside production the same absence means the opposite — any verified Google account
may sign in — and that is deliberately scoped to development: a checkout has to work
after `npm install` with no list to invent, and a developer signing in to their own
machine is not an access-control question. It is a development affordance, not a rule
with an exception.

### Where hosted state lives

Six things have to outlive a request: registered clients, logins in progress,
authorization codes and refresh tokens for the MCP flow, and — for the website
rather than for MCP clients — sign-ins in progress and signed-in browser sessions.
They are in **Postgres**, and the reason is narrower than "it needs a database": most
of them must be spendable **exactly once**. An authorization code presented twice, by
two instances, in the same millisecond, may be honoured once; so may a refresh token,
and so may either kind of login in progress. Each is one statement:

```sql
DELETE FROM oauth_authorization_codes
 WHERE code_hash = $1 AND expires_at > $2
 RETURNING …
```

Locating the row, checking its expiry, removing it and returning it happen
indivisibly, so the database settles the race and no application-level lock exists to
get wrong. A read followed by a delete would look equivalent and would not be.

**Access tokens are not in there.** They stay signed, self-contained JWTs, so `/mcp`
validates one from the token and the signing key alone — no query, and the same
answer on every instance.

What a client holds is never stored: rows are keyed by the SHA-256 of the code or
token, so a copy of the database is not a set of working credentials.

In development `DATABASE_URL` is unset and the same schema runs on an embedded
Postgres — the real thing compiled to WebAssembly — so `npm install && npm run dev`
needs no database installed and the SQL under test is the SQL that ships. Production
is a real Postgres and **fails at startup without one**, rather than falling back to
a store that a restart or a second instance would invalidate.

Initialise or update the schema, before the new code serves traffic:

```bash
npm run db:migrate     # idempotent, and safe to run from several instances at once
```

In production this is **required**, and it is the only thing that changes the schema
there: an instance checks that the migrations its code needs have been applied and
refuses rather than applying them itself. Run it before the build that needs it goes
live — see [Deploying it](#deploying-it) for the exact order.

Expired rows are deleted opportunistically after writes, and `npm run db:migrate` is
the only schema step a deploy needs. Cleanup is never load-bearing: every read filters on
expiry, so an expired code is refused whether or not anything has swept it.

### Per-user state

The labels and match history a connected client works on are that user's, in the
same Postgres but under their own tables. `AuthenticatedUser.id` — the stable,
provider-qualified subject the OAuth boundary produces — is the ownership boundary,
and it leads every key:

```text
inbox_labels                  (user_id, label)  type, role, attention, instruction
inbox_label_references        which detection labels a derived label builds on
inbox_label_daily_matches     (user_id, label, day) → count
inbox_label_match_state       (user_id, label) → last_matched_at
```

`role` is `category` or `attribute`, and is the one **nullable** column here. New detection
labels must state it — the code enforces that on create, because a column cannot express
"required from now on" — while a label written before the distinction existed keeps a null, which
means unmodelled rather than defaulted. A derived label may never have one: two CHECK constraints
carry both halves, `role IS NULL OR role IN ('category', 'attribute')` and
`type = 'detection' OR role IS NULL`. Nothing backfills the nulls and nothing infers a value from
a label's name or instruction; the role also takes no part in matching.

The store is opened *for* a user and takes no user argument afterwards, so no tool
schema has a `user_id` field and there is nowhere for a client to name someone else.
Two users may both have an `Invoices`; neither can see the other's.

The label text is the key here as it is in the files, and the foreign keys are
`ON UPDATE CASCADE`. That is what makes the two hard operations single statements
rather than careful sequences:

- **Renaming** a label carries its match history and every reference to it, with no
  moment in between where a label is under one name and its counts under another.
- **Deleting** one takes its history with it, and is refused while another label
  references it.

`record_matches` increments with an upsert and settles `last_matched_at` with
`GREATEST`, both inside the statement — so simultaneous recordings cannot lose a
count, and a backfilled old email raises its own day without dragging the
newest-seen timestamp backwards.

**Only aggregates are stored.** A label, a UTC day, a count, and one timestamp. There
is no column for a subject, sender, recipient, body, message id, thread id or
attachment, and no table with a row per email — the store can answer "how often does
this label fire" and is structurally unable to answer anything about a message.

A new user starts empty: a first `get_labels` returns an empty list rather than
labels somebody else chose. Nothing seeds an account, and the starter set is
created only on request — see
[`inbox-labeler-setup`](skills/inbox-labeler-setup/SKILL.md).

### Running it

```bash
cd web
npm install
npm run dev
```

The two discovery documents need no configuration at all — they carry nothing signed,
so a missing secret must not be what breaks them:

```bash
curl -s localhost:3000/.well-known/oauth-protected-resource/mcp
curl -s localhost:3000/.well-known/oauth-authorization-server
```

`/mcp` and the token endpoint do need `OAUTH_SIGNING_SECRET`, because without it no
token can be signed or checked. Until it is set they answer `500` rather than letting
a request through unvalidated — the response says only that the server is
misconfigured, and the reason is on stderr, where `next dev` is already printing.
With it set, an unauthenticated call is a `401` whose challenge points back at the
metadata above:

```bash
curl -si -X POST localhost:3000/mcp -d '{}' | grep -i www-authenticate
# Bearer error="invalid_token", …, scope="mcp",
#   resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"
```

Registration, the request checks and the consent page work with the secret alone —
enough to see everything up to the point where a real Google account is needed:

```bash
CID=$(curl -s -X POST localhost:3000/oauth/register \
  -H 'content-type: application/json' \
  -d '{"redirect_uris":["http://localhost:41234/callback"],"client_name":"Probe"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["client_id"])')

open "http://localhost:3000/oauth/authorize?client_id=$CID\
&redirect_uri=http%3A%2F%2Flocalhost%3A41234%2Fcallback&response_type=code\
&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM\
&code_challenge_method=S256&scope=mcp&state=st1"
```

For the whole flow end to end, set the Google variables too and point the MCP
Inspector at the endpoint — it drives the handshake itself, browser round trip
included:

```bash
npx @modelcontextprotocol/inspector
# transport: Streamable HTTP    URL: http://localhost:3000/mcp
```

It registers itself, shows the consent page, sends you to Google, comes back with a
token and lists `get_server_info`.

The web tests cover the same ground without a browser or a Google account:

```bash
cd web
npm test          # includes the MCP endpoint and the OAuth flow
npm run typecheck
npm run lint
```

**Loopback is enough for local development, and only because it is loopback.** The
OAuth flow otherwise requires HTTPS, so the discovery documents refuse a plain-HTTP
origin anywhere else — no tunnel is needed to develop against `localhost`, and no
tunnel makes a non-loopback HTTP origin acceptable.

### Deploying it

Vercel for the application, Neon for the database. There is no `vercel.json` and no
build script of its own: Next.js is detected, `next build` is the build, and the
route handlers become functions. The only project setting that is not a default is
the root directory, because the application lives in `web/`.

**1. Neon.** Create a project and a database, then copy the **pooled** connection
string — the host with `-pooler` in it. Each serverless instance keeps its own small
pool, so many instances pointed at the direct endpoint would exhaust the compute's
connection limit; the pooler is built for that shape. Keep the `?sslmode=require`
Neon's string already carries: that is what turns TLS on.

**2. Vercel.** Import the repository and set **Root Directory** to `web`. Then add
the environment variables from [`web/.env.example`](web/.env.example) — five of them
are required in production:

| | |
| --- | --- |
| `DATABASE_URL` | the pooled Neon string — **secret** |
| `PUBLIC_ORIGIN` | `https://inboxlabeler.com` |
| `OAUTH_SIGNING_SECRET` | `openssl rand -base64 48` — **secret** |
| `GOOGLE_CLIENT_ID` | the Google client |
| `GOOGLE_CLIENT_SECRET` | its secret — **secret** |

And four more for the legal pages, which are configuration rather than source
because for a deployment run by an individual they are a person's name and home
address:

| | |
| --- | --- |
| `LEGAL_NAME` | the operator's name |
| `LEGAL_ADDRESS_LINE_1` | street and number |
| `LEGAL_ADDRESS_LINE_2` | postcode and place |
| `LEGAL_CONTACT_EMAIL` | the address data-protection requests go to |

All four are required together. With any of them unset, `/impressum`, `/privacy`
and `/terms` answer `404` rather than render a disclosure that names nobody. No
other route reads them.

`ALLOWED_EMAILS` is separate from those and is **required in production**: it must
name at least one invited address, or nobody is admitted. Unset, empty, blank and
comma-only are all the same misconfiguration and all refuse every sign-in — see
[Who may sign in](#who-may-sign-in).

`PUBLIC_ORIGIN` is an origin, not the MCP endpoint's URL — `https://inboxlabeler.com`, never
`…/mcp`; a path, query or fragment is refused rather than silently dropped. It must
be the canonical domain rather than a per-deployment hostname:
the issuer and a token's audience are compared literally by clients, so a preview URL
would mint tokens nothing accepts at the real one.

**Scope the variables to Production, and give previews their own.** Vercel offers a
deployment its own hostname as well as the one the domain points at, and by default
every environment sees the same variables. That would put the authorization server at
several addresses at once, all signing with the same key and writing to the same
database, while the metadata names only one of them. Two things follow:

- In Project Settings → Environment Variables, add `DATABASE_URL`,
  `OAUTH_SIGNING_SECRET` and the Google pair to **Production only**. Give Preview and
  Development their own Neon branch, their own secret and their own Google client, or
  leave them unset — a preview with no secrets refuses the requests that need them,
  which is the right answer.
- Even so, the OAuth and MCP endpoints refuse any request whose `Host` is not the
  configured origin's, and answer `404` — so a preview that did inherit production
  secrets still cannot run a flow or mint a token. The check reads `Host` and never
  `X-Forwarded-Host`, which a caller can set.

Preview deployments are therefore not usable for a real OAuth flow. That is the
intended consequence, not a limitation to work around.

**3. Google.** In the same Cloud project as the OAuth client, add exactly:

```text
Authorised JavaScript origin   https://inboxlabeler.com
Authorised redirect URI        https://inboxlabeler.com/oauth/callback
Authorised redirect URI        https://inboxlabeler.com/auth/callback
```

**Both redirect URIs, because two different flows come back from Google:**
`/oauth/callback` is where an **MCP client's** authorization returns, and
`/auth/callback` is where a **person signing in to the website** returns. They resume
different records and neither can do the other's job. Miss one and that flow fails
with Google's `redirect_uri_mismatch`, while the other keeps working — so the symptom
is "sign-in is broken but my MCP client is fine", or the reverse.

None of the three is written down in the application. Both callback URLs are derived
from `PUBLIC_ORIGIN`, so pointing the deployment at a different domain needs no code
change — only the matching entries here.

**4. Migrate — before the new build serves, not after.** This step is **required in
production**, and it is the only thing that changes the schema there:

```bash
cd web
DATABASE_URL='<the pooled Neon string>' npm run db:migrate
```

**Production never migrates itself.** A production instance opening a store *checks*
that the migrations its code needs have been applied and raises a configuration error
if any are missing; it runs no DDL of its own, and reads one row to decide. A request
from the internet must not be what migrates a database — the first request after a
deploy is an arbitrary one, several instances would race to be it, and a migration
failing halfway would do so inside somebody's page load with nobody watching.

So the order is fixed, and getting it backwards is an outage rather than a delay:

```text
1  set or verify the production environment variables
2  DATABASE_URL='<pooled Neon string>' npm run db:migrate
3  confirm it succeeded — it prints what it applied
4  only then deploy or promote the new build
```

Outside production the schema is still brought up to date automatically, so a local
checkout needs no extra step.

The command is idempotent and safe to run twice or from two places at once. A failure
exits non-zero with the Postgres error rather than continuing.

The command refuses to run without `DATABASE_URL`. It will not quietly migrate the
embedded development database instead — a deploy step whose variable failed to reach
it would otherwise report success having changed a database that lives for the length
of the process. To migrate the local one, say so: `npm run db:migrate -- --embedded`.

**5. Check it.** These need no credentials and no client:

```bash
curl -s https://inboxlabeler.com/.well-known/oauth-protected-resource/mcp
curl -s https://inboxlabeler.com/.well-known/oauth-authorization-server
curl -si -X POST https://inboxlabeler.com/mcp -d '{}' | grep -i www-authenticate
```

The first two must name `https://inboxlabeler.com` throughout, and the third must be
a `401` whose challenge points back at the first. A `500` instead means a required
variable is missing — the response says only that the server is misconfigured, and
the specific variable is in the Vercel function logs, because a public endpoint
should not tell a stranger how a deployment is put together.

### Connecting ChatGPT

Add a connector pointing at:

```text
https://inboxlabeler.com/mcp
```

Nothing else is configured. The client reads the `401`, follows it to the protected
resource metadata, finds the authorization server, registers itself, and opens the
browser for the consent page and Google sign-in. After that its tools are
`get_labels`, `create_label`, `update_label`, `delete_label`, `get_matches`,
`record_matches` and `get_server_info`, all acting on the account that signed in.

**The web UI is per-user.** `/` is one address in two states: signed out it is the
public landing page and its closed-beta notice, and signed in it is the visitor's own
labels. The signed-in half reads them server-side through `inboxStore(visitor.user)` —
the same store `get_labels` and `get_matches` answer from, scoped to the account the
session cookie resolves to — so the page and an MCP client on one Google account
always agree. There is no local label file any more: the store is the only place labels live.

### What is not finished

- **Tokens cannot be revoked before they expire**, which follows from their being
  self-contained. They last an hour; rotating `OAUTH_SIGNING_SECRET` invalidates all
  of them at once.
- **No `revocation_endpoint`**, and registration uses the mechanism the MCP
  specification now marks deprecated (RFC 7591) because it is the one clients speak
  today. Client ID Metadata Documents are the successor to add.
- **The authentication tests drive handlers, not a browser.** They build a `Request`,
  read the `Set-Cookie` back, and hand it to the next call — which proves the server's
  half of every rule and none of the browser's. What no test yet exercises: a
  production build served over HTTP, a real cookie jar in two isolated browser
  contexts, a browser actually honouring `__Host-` and `SameSite` across the return
  from Google, duplicate cookies, two callbacks racing, an empty allowlist in a
  genuinely production process, the response cache headers as sent, and a
  migrate-then-deploy against a real database. Each of those is currently correct by
  construction and asserted at the handler; this is a regression-detection gap rather
  than a known fault, and it is worth closing **before an external beta** rather than
  for owner-only testing.

## Repository layout

Four Agent Skills implement Inbox Labeler, one per job:

| Skill | Owns |
| --- | --- |
| **`inbox-labeler-setup`** | initialize an empty Inbox Labeler with a starter label set |
| **`inbox-labeler-manage`** | create, model, rename and delete labels |
| **`inbox-labeler-process`** | classify new unread inbox mail, and record what matched |
| **`inbox-labeler-attention`** | star or mark read the mail that has already been processed |

One skill per job, so an agent asked to rename a label does not also load the ten-message bound
and the Gmail query. All four reach labels and match history through the same remote MCP server,
and the two that touch mail use Gmail as well. A message is eligible for processing when it is in
the inbox, unread and not yet carrying `IL/processed`, and a run stops after **ten messages**.

```
skills/inbox-labeler-setup/
├── SKILL.md              the starter label set, created into an empty configuration
└── test.sh               its own test suite
skills/inbox-labeler-manage/
├── SKILL.md              creating, modelling, renaming and deleting labels
└── test.sh               its own test suite
skills/inbox-labeler-process/
├── SKILL.md              classifying new unread inbox mail, and recording what matched
└── test.sh               its own test suite
skills/inbox-labeler-attention/
├── SKILL.md              the Gmail state that follows from the labels already on a message
└── test.sh               its own test suite
web/
├── app/                  the web UI, and the MCP and OAuth routes
└── lib/
    ├── identity.ts       who an authenticated request belongs to — one stable id
    ├── db.ts, db/        one Postgres connection, and the migrations for all three schemas
    ├── mcp/              the MCP server, its tools, and the auth boundary
    ├── inbox/            per-user labels and match history
    └── oauth/            the authorization server: discovery, grants, tokens
README.md
```

`skills/` is the one copy of each skill, and it names no agent.

### How the skills are found

Agents discover skills by directory, not by filename — a `SKILL.md` sitting at a repository root
is *not* picked up. It must be at `<skills-dir>/<skill-name>/SKILL.md`, and each agent looks
under a different `<skills-dir>`: Claude Code under `.claude/skills/`, Codex under
`.agents/skills/`.

Nothing is committed under either. These four skills reach your labels through the remote MCP
server rather than through anything in this checkout, so they are useful from any project — link
the ones you want into your personal skills directory instead:

```bash
mkdir -p ~/.claude/skills
for skill in setup manage process attention; do
  ln -s "$PWD/skills/inbox-labeler-$skill" ~/.claude/skills/inbox-labeler-$skill
done
```

Restart the agent afterwards and confirm with `/skills`. Then connect the MCP server — see
[Remote MCP (development)](#remote-mcp-development) — and ask for what you want: "set up Inbox
Labeler", "add a label for invoices", "process my inbox".

## Testing

No test framework: a shell script per skill, and `node --test` for the web application.

```bash
skills/inbox-labeler-setup/test.sh      # the starter set, checked as data
skills/inbox-labeler-manage/test.sh     # the label model and the boundaries around it
skills/inbox-labeler-process/test.sh    # eligibility, the ten-message bound, the two stages
skills/inbox-labeler-attention/test.sh  # the scope, the ranking, and its two writes
cd web && npm test                      # the store, the MCP boundary, OAuth, and sign-in
```

Each skill script prints one line per check and exits non-zero if any fails. The four are
**Markdown contract regression tests**: they ask one question — did someone remove or alter an
explicit contract rule? — using canonical phrases, exact table data, counts and document order,
because those flows live in prose rather than code and would otherwise drift. They deliberately
do not try to prove that no sentence anywhere in a `SKILL.md` could contradict the contract; that
is a reviewer's job, and each file says so.

The setup suite is the one that reads a table as data: it checks that the fifteen starter labels
are still the agreed fifteen, with the agreed types, attention levels and references, in the
agreed creation order, and that the fifteen instructions below that table are those same fifteen
labels in that same order. The instruction *text* is pinned nowhere — `SKILL.md` is the only
definition of what Setup creates, and a second copy of it would only be a second thing to keep
true.

## Scope

Deliberately small. One store per account, in Postgres, reached only through the hosted
application: the MCP endpoint for a client, the signed-in page for a browser. No scheduler, and
nothing runs in the background — a run happens when somebody asks for one. Mailbox work happens
through Claude's Gmail connector as described in each `SKILL.md`; nothing in this repository
holds a Google credential of the user's, and no skill reaches the network on its own.

The classifying itself is Claude reading the email against your instructions — there is no model
called from the code, no prompt file, and nothing to configure. Which is also why two runs over
the same mail can differ in judgement, while everything deterministic — validation, label
identity, attention levels, the behaviour each level implies — lives in `web/lib/` and is tested.

## License

Inbox Labeler is released under the MIT License — see [`LICENSE`](LICENSE) for the full text.
Use it, change it and redistribute it freely, including commercially; the only condition is
that the copyright notice travels with it, and it comes with no warranty.
