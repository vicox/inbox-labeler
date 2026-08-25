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

Take three labels from [`labels.example.json`](data/labels.example.json),
the reference set introduced in [Getting started](#getting-started). Each one starts from two
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
  "attention": "normal",
  "instruction": "The message is a shipping or delivery status update for an order (e.g. 'out for delivery', 'delivered', 'shipped', tracking updates from a carrier or retailer like Amazon, DHL, UPS)."
}
```

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
labels comes out `normal`, so it is left alone. The policies above are fixed and not configurable.

A label's own Attention also sets its Gmail label's **color**, using Gmail's muted palette so
it stays out of the way — `none` light gray, `normal` muted yellow, `high` muted red, from the
one mapping `labels.py` keeps for it. Color is purely
presentation: it never feeds back into what a label detects or how attention is computed, and
message processing never recolors a message — only the Gmail label itself, and only Detection
and Derived Labels get one; the reserved system labels never do. It's set the moment a Gmail
label is created and kept in sync whenever a label's Attention changes, so no color is ever
chosen or edited by hand.

Inbox Labeler resolves each label to a Gmail label inside its own `IL/` namespace whenever it
talks to Gmail — `IL/` itself is never part of a label's identity and is never stored anywhere.
[How processing works](#how-processing-works) covers the full namespace, including the two
reserved system labels.

## Getting started

**New to Inbox Labeler? Start from
[`labels.example.json`](data/labels.example.json).** It's a small,
coherent set of detection labels, derived labels built on top of them, and attention levels —
production-quality and usable as-is, but meant as a demonstration of the core modeling
concepts, not a one-size-fits-all configuration. Copy the labels you want into your own
`data/labels.json` (or paste them one at a time through the CLI) and adjust the instructions to your
own mail. It is not imported automatically; nothing in Inbox Labeler ever reads it on its own.

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

### CLI examples

From `skills/inbox-labeler/`:

```bash
python3 labels.py list
python3 labels.py get "Large amount"

# a detection label
python3 labels.py create --label "Invoices" \
  --instruction "The message is an invoice or bill for a purchase or service."

# a derived label — the reference flags are repeatable
python3 labels.py create --label "Large invoice" --type derived \
  --instruction "An invoice whose amount is large enough to need a closer look." \
  --required-label "Invoices" --required-label "Large amount"

python3 labels.py update "Invoices" --instruction "The message is an invoice, bill or receipt."

# rename, rewriting every reference to it
python3 labels.py update "Large amount" --label "Big amount"

python3 labels.py delete "Invoices"

# set what a label asks of you
python3 labels.py update "Newsletter" --attention none
python3 labels.py update "Imminent" --attention high

# the two helpers the attention command uses — these touch nothing
python3 labels.py attention "Invoices" "Imminent"   # which level do these labels add up to?
python3 labels.py policy none --age 30h             # and what follows for a 30h old message?
python3 labels.py color high                        # which Gmail color does this level get?
```

`--label` takes the label itself — `Invoices`, not `IL/Invoices`. Anything starting with `IL/`
is rejected, as are the reserved system labels `processed` and `no-match`. Spaces are expected; quote the
argument.

`--type` defaults to `detection` and `--attention` to `normal`; every command prints both, so
the kind of label and what it asks for are always visible. Unknown values are rejected.

`--required-label` and `--recommended-label` apply to derived labels only and name existing
detection labels by their exact text. On update they replace the stored list rather than adding
to it; passing an empty value clears it.

`get`, `update` and `delete` address a label by its text, matched case-insensitively. Passing
`--label` to `update` renames the label. Every command prints JSON; on a validation failure it
prints `{"error": "..."}` and exits with status 1.

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
label already on a message stays until you remove it in Gmail yourself.

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
something a user models. `labels.py` rejects them on create, on rename and on delete, in any
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
definitions either in the local copy or in Drive for step zero to load. A run with no
definitions stops and reports instead of doing anything.

## Persistence

Inbox Labeler's **state** is two files:

| | | |
| --- | --- | --- |
| `labels.json` | **required** | the **policy** — every label, its type, its instruction, its attention |
| `matches.json` | **optional** | the **match history** — aggregated counts, absent until a run records something |

The `gdrive-store` skill synchronises that state with Google Drive. Two places, with one of them
in charge:

| | |
| --- | --- |
| **Google Drive**, `Inbox Labeler/` | **canonical** — the state of record |
| `data/` | the local working copy the agent reads while running |

Neither local copy is committed — both are in `.gitignore`, so the repository holds only source,
documentation and the example file.

**Loading is automatic, saving is not.** Before processing anything, Inbox Labeler checks the
local copy; if it is empty it loads the definitions from Drive through the
`gdrive-store` skill. If Drive has none either, it stops and says so rather than
processing with an empty rulebook. Changes you make with the CLI or by asking Claude land in
the local copy only — say **"save the labels"** to write them back to Drive.

**"save the labels" saves the match history too**, when there is one; if `data/matches.json`
does not exist yet, that is not an error and nothing is invented to fill the gap.

Saving always creates a *new* file in the Drive folder and the newest one of each name is
canonical; older versions stay put. The Drive connector cannot update or delete a file in place,
so pruning old versions is a manual job in the Drive UI.

Loading works the other way and is blunt about it: a file that comes down from Drive **replaces**
the local one, because Drive is what is canonical. For counts that is worth knowing — matches
recorded since the last save are lost when a newer history is loaded, so save first if a run has
happened in between. A missing `matches.json` in Drive changes nothing locally; it means no
history stored yet, not a failure.

Nothing needs to be set up to start: the first `list` or `create` writes an empty
`data/labels.json`. Deleting `labels.example.json` changes nothing at runtime — see
[Getting started](#getting-started) for what it's there for.

## What matched, and how often

`data/matches.json` counts how often each label has matched, and is the one thing Inbox Labeler
keeps after a run. It is written only by `matches.py`; label definitions never hold a count.

**It records that a label matched, not what it matched.** Per label it holds the newest email
timestamp it has seen and a count per calendar day — nothing more. No subject, no sender, no
recipients, no message or thread id, nothing about an attachment, nothing that could lead back
to a message:

```json
{
  "Invoices": {
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
email a label has matched, not the last time the store was written. Days with no matches are
not stored. The file is optional: it does not exist until a run records something, and it is
local and gitignored, like `labels.json`.

Recording is part of `process` — see [How processing works](#how-processing-works). By hand:

```bash
cd skills/inbox-labeler
python3 matches.py record --at 2026-08-20T10:12:00Z "Invoices" "Large amount"
python3 matches.py list                  # every label that has ever matched
python3 matches.py get "Invoices"        # one label
```

A rename carries the counts across and a delete removes them, both driven from `labels.py`, so
the two files never disagree about which labels exist.

The `gdrive-store` skill has its own two commands, for checking either file by hand:

```bash
cd skills/gdrive-store
python3 store.py validate FILE            # every problem at once, not just the first
python3 store.py format   FILE [--write]  # stable, human-readable JSON
```

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
Inbox Labeler user authenticated — the same model the CLI works on, for a hosted
account rather than a local file:

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
it, or applies attention — `process` and `attention` remain the local skill's work.
These tools are the state those runs would read and write, which is why
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
| `ALLOWED_EMAILS` | optional: comma-separated addresses allowed to sign in. Unset means any verified Google account may — see [Who may sign in](#who-may-sign-in) |
| `DEV_DATABASE_DIR` | development only: where that embedded database keeps its files. Unset means in-memory |

The Google client needs one authorised redirect URI, matching `PUBLIC_ORIGIN`:
`http://localhost:3000/oauth/callback` locally. The scopes are `openid email` — the
address is read to check the access list below and then dropped, and `profile` is
not requested, so Inbox Labeler never learns a name or a picture.

`.env.local` is gitignored. `.env.example` holds names and never values.

### Who may sign in

Signing in requires a Google account, and Google will vouch for anybody's.
`ALLOWED_EMAILS` is the whole of Inbox Labeler's access control, and how a private
beta is closed. It is **optional**, and has exactly two behaviours:

| `ALLOWED_EMAILS` | Who may authenticate |
| --- | --- |
| configured | only the listed addresses |
| unset or empty | any Google account with a verified email address |

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
subject, which survives them changing their address — so a beta tester who renames
their account keeps their labels. Nothing stores the address, and no token,
database row or MCP result carries it.

#### Why an empty list is not an error

Leaving `ALLOWED_EMAILS` unset accepts every Google account, and that is a
decision rather than a gap. It is what makes the variable optional, and it buys
three things worth having in a V1:

- **A local checkout works after `npm install`**, with no list to invent or keep
  up to date.
- **Closing the beta is one variable**, set in one place, with nothing else to
  change or deploy.
- **There is one rule, not one per environment.** Requiring the list only in
  production would mean the behaviour you tested locally is not the behaviour that
  runs — and an access rule that differs by environment is the kind that is
  discovered rather than reviewed.

Reading an empty string as "nobody" was the other option, and it is worse: an
unset variable is somebody who has not chosen yet, not somebody who has chosen to
lock everyone — including themselves — out of their own deployment.

So a hosted deployment with no list is open to every Google account. Set the
variable when the answer is "these people".

### Where hosted state lives

Four things have to outlive a request: registered clients, logins in progress,
authorization codes and refresh tokens. They are in **Postgres**, and the reason is
narrower than "it needs a database" — it is that two of them must be spendable
exactly once. An authorization code presented twice, by two instances, in the same
millisecond, may be honoured once; so may a refresh token. Each is one statement:

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

Expired rows are deleted opportunistically after writes, and `npm run db:migrate` is
the only step a deploy needs. Cleanup is never load-bearing: every read filters on
expiry, so an expired code is refused whether or not anything has swept it.

### Per-user state

The labels and match history a connected client works on are that user's, in the
same Postgres but under their own tables. `AuthenticatedUser.id` — the stable,
provider-qualified subject the OAuth boundary produces — is the ownership boundary,
and it leads every key:

```text
inbox_labels                  (user_id, label)  policy: type, attention, instruction
inbox_label_references        which detection labels a derived label builds on
inbox_label_daily_matches     (user_id, label, day) → count
inbox_label_match_state       (user_id, label) → last_matched_at
```

The store is opened *for* a user and takes no user argument afterwards, so no tool
schema has a `user_id` field and there is nowhere for a client to name someone else.
Two users may both have an `Invoices`; neither can see the other's.

The label text is the key here as it is in the files, and the foreign keys are
`ON UPDATE CASCADE`. That is what makes the two hard operations single statements
rather than careful sequences:

- **Renaming** a label carries its match history and every reference to it, with no
  moment in between where the policy is under one name and its counts under another.
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

A new user starts empty. [`labels.example.json`](data/labels.example.json) is
documentation, and nothing in Inbox Labeler has ever read it on its own — locally or
here — so a first `get_labels` returns an empty list rather than labels somebody else
chose.

The local [`labels.py`](skills/inbox-labeler/labels.py) and
[`matches.py`](skills/inbox-labeler/matches.py) remain the semantic reference and
remain supported: the file-based workflow is unchanged, and
`web/lib/inbox/parity.test.ts` reads the Python source to check the two have not
drifted apart on what a label is.

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

`ALLOWED_EMAILS` is optional and separate from those: with it, only the listed
addresses may sign in; without it, any Google account with a verified email may.
Both are intended — see [Who may sign in](#who-may-sign-in).

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
```

Neither is written down in the application. The callback URL is derived from
`PUBLIC_ORIGIN`, so pointing the deployment at a different domain needs no code
change — only the matching entry here.

**4. Migrate.** Once, against the production database, before the new code serves:

```bash
cd web
DATABASE_URL='<the pooled Neon string>' npm run db:migrate
```

It is idempotent and safe to run twice or from two places at once, and it prints what
it applied. Opening a store migrates too, so a forgotten run is not an outage — but
only the command can be ordered in a deploy. A failure exits non-zero with the
Postgres error rather than continuing.

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

**One known gap in the hosted deployment.** The web UI at `/` reads
`data/labels.json` from the filesystem, which is the local workflow's file and is not
part of a Vercel deployment — so the page renders its "No policy yet" notice there,
while the MCP endpoint works normally against Postgres. Giving the UI the hosted,
per-user state means signing users in on the web as well, which is its own piece of
work and deliberately not part of this one.

### What is not finished

- **Tokens cannot be revoked before they expire**, which follows from their being
  self-contained. They last an hour; rotating `OAUTH_SIGNING_SECRET` invalidates all
  of them at once.
- **No `revocation_endpoint`**, and registration uses the mechanism the MCP
  specification now marks deprecated (RFC 7591) because it is the one clients speak
  today. Client ID Metadata Documents are the successor to add.

## Repository layout

Two Agent Skills implement Inbox Labeler:

| Skill | Owns |
| --- | --- |
| **`inbox-labeler`** | the labels, and the Gmail work — `process` and `attention` |
| **`gdrive-store`** | the canonical state in Google Drive — `labels.json` and `matches.json`, loading and saving both |

```
skills/inbox-labeler/
├── SKILL.md              the instructions the agent follows
├── labels.py             the CRUD implementation (Python 3 stdlib, no dependencies)
├── matches.py            how often each label matches — counts only, never mail
└── test.sh               the test suite — runs in a temp dir, touches nothing real
skills/gdrive-store/
├── SKILL.md              how to load and save the canonical state in Drive
├── store.py              validation and stable serialisation
└── test.sh               its own test suite
data/
├── labels.example.json   documentation only, never read at runtime
├── labels.json           the working copy — local, gitignored, created on first use
└── matches.json          match counts — local, gitignored, created on first use
web/
├── app/                  the web UI, and the MCP and OAuth routes
└── lib/
    ├── identity.ts       who an authenticated request belongs to — one stable id
    ├── db.ts, db/        one Postgres connection, and the migrations for both schemas
    ├── mcp/              the MCP server, its tools, and the auth boundary
    ├── inbox/            per-user labels and match history — labels.py's semantics
    └── oauth/            the authorization server: discovery, grants, tokens
README.md
```

`skills/` is the one copy of each skill, and it names no agent. The agents reach it through
symlinks, described below. The labels live outside both skills in `data/`, because they are
the user's, not the skill's — a second reader such as the web UI needs them just as much.

### How the skills are found

Agents discover skills by directory, not by filename — a `SKILL.md` sitting at a repository
root is *not* picked up. It must be at `<skills-dir>/<skill-name>/SKILL.md`, and each agent
looks under a different `<skills-dir>`: Claude Code under `.claude/skills/`, Codex under
`.agents/skills/`. Both are committed here as symlinks back to `skills/`:

```
.claude/skills/inbox-labeler  -> ../../skills/inbox-labeler
.agents/skills/inbox-labeler  -> ../../skills/inbox-labeler
```

So there is no installation step and no copy to keep in sync. Start either agent in this
project and both skills are there:

```bash
cd /path/to/inbox-labeler
claude        # or: codex
```

Confirm with `/skills` in Claude Code or `/skills` in Codex — they appear as `inbox-labeler`
and `gdrive-store` — or just ask "list my labels".

**To use the skills in every project**, link them into your personal skills directory, which
is `~/.claude/skills/` for Claude Code and `~/.agents/skills/` for Codex:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/inbox-labeler" ~/.claude/skills/inbox-labeler
```

Link rather than copy: `labels.py` resolves the store relative to its own location, so a copy
outside this repository would read a `data/labels.json` somewhere else. Restart the agent
after adding it.

## Testing

No test framework, just a shell script per skill. Each copies its module into a temporary
directory, so your own labels are never touched:

```bash
skills/inbox-labeler/test.sh        # the labels, attention, and the documented flows
skills/gdrive-store/test.sh         # validation and serialisation, for both files
```

Each prints one line per check and exits non-zero if any fails. Between them they cover the CRUD
surface, label identity and renaming, the two label types and their references including cycle
detection, the reserved system labels, attention levels and the policy each one implies, and
migration from older stores. A number of checks assert the *documentation* — that `SKILL.md`
still states the processing order, the ten-message limit and the boundaries between the
commands — because those flows live in prose rather than code and would otherwise drift.

Migration is worth knowing about, and there is no command to run for it. A store written by an
earlier version may carry a technical `id`, a separate `name`, an `IL/` prefix on the label, or
no `type` at all. Loading it drops the `id` and `name`, falls back to the old `name` if the
label is missing, strips one leading `IL/`, trims and collapses whitespace, and fills in
`type: detection` — all in memory, so `list` already shows the current shape and the next write
persists it. Turning a `CamelCase` label into a readable phrase is a rename you make
deliberately: `update "LargeAmount" --label "Large amount"`, which carries the references
along.

## Scope

Deliberately small: a JSON file per store, no database, no server, no auth of its own, no
scheduler, no UI. Gmail and Drive work happens through Claude's connectors as described in each
`SKILL.md`; the Python modules never touch the network.

The classifying itself is Claude reading the email against your instructions — there is no model
called from the code, no prompt file, and nothing to configure. Which is also why two runs over
the same mail can differ in judgement, while everything deterministic — validation, label
identity, attention levels, the policy for each level — lives in the modules and is tested.

## License

Inbox Labeler is released under the MIT License — see [`LICENSE`](LICENSE) for the full text.
Use it, change it and redistribute it freely, including commercially; the only condition is
that the copyright notice travels with it, and it comes with no warranty.
