---
name: inbox-labeler-overview
description: Show already processed unread inbox mail as a scannable overview. Groups each email under one representative Inbox Labeler label chosen by the MCP server, shows compact facts per row, and marks messages read only when the user explicitly asks.
---

# Inbox Labeler — overview

One job: show mail that has **already been processed**, grouped so the user can work through
dozens of messages by scanning instead of opening them. It **classifies nothing** and it **never
adds or removes an `IL/` label** — `inbox-labeler-process` owns labelling, and this reads what
that produced.

An **operational view**, and none of these: an email client, a prose digest, a fresh
classification pass, an Attention run, or a way to edit labels.

**Run this only when the user asks for it.** It is never part of a processing run, it does not
follow one, and neither processing nor attention may chain into it on its own initiative. After
mail has been processed, say that an overview is available and wait to be asked.

**Two connections do different things.** Inbox Labeler's MCP server holds the labels, the match
history and the ranking and has no access to the mailbox; Gmail holds the mail. `get_labels` and
`get_representative_labels` are the MCP's; `list_labels`, `search_threads`, `get_thread` and
`unlabel_message` are Gmail's. You hold the two together, and the messages stay on your side —
see [What each side is told](#what-each-side-is-told). Identity is the authenticated MCP session:
never ask the user for an account id and never pass one to any tool.

## Scope

Only **unread inbox messages that carry `IL/processed`** — the same scope
`inbox-labeler-attention` works on, and the mirror image of processing. Archived mail and read
mail are out of scope, and so is anything without `IL/processed`.

There is **no message limit**. The whole eligible inbox goes into one overview, because scanning
half of it is worse than scanning none.

## Building the overview changes nothing

Producing the overview is a read. Nothing is archived, deleted, relabelled, starred, classified,
replied to or marked read because an overview was built, because the user selected a row, or
because they looked at one.

The one thing this skill ever writes to Gmail is clearing `UNREAD`, and only through
[Marking messages read](#marking-messages-read), which happens when the user asks for it and at
no other moment.

## What each side is told

- **Gmail** knows the messages: their ids, senders, subjects and bodies.
- **Inbox Labeler's MCP server** knows the label model and does the ranking. It is given
  **label texts and nothing else** — no message id, no thread id, no sender, no subject, no
  snippet, no body.
- **You** hold the mapping between the two, and you keep it. It is never shown to the user and
  never sent to the MCP server.

## The label provides the meaning. The row provides the facts.

Every email is shown **exactly once**, under the one label that represents it, as one compact
row. The heading already says what kind of thing this is, so the row does not repeat it:

- extract only the facts the representative label is about
- show the minimum needed to understand the email at a glance
- do **not** summarise the email, and do **not** explain the label
- avoid full sentences

Prefer compact fragments: amounts, names, dates and times, IDs, counts, versions, statuses,
outcomes, short changes. The facts are the prominent part of a row; the labels beside them are
quieter.

```text
💰 Large invoice

☐ ACME GmbH · €18,420 · INV-4831 · due Aug 14
  [Invoices] [Large amount] [Action required]
```

Every section heading gets a fitting icon. **Icons are presentation only** — one is chosen for a
heading after the ranking has decided it, and never takes part in deciding it.

The example above shows the shape of a row, nothing more. **Never invent a label because an
example used one**: the only labels that appear anywhere in an overview are the ones actually on
the mail.

## The representative label is not yours to choose

**Never decide by reading the email, and never decide by judgement.** Which of an email's labels
represents it is settled by `get_representative_labels`, and that is the only thing that settles
it. Do not re-rank its answer, do not override it because a different label reads better in the
section, and do not work the ranking out yourself — a judgement made twice gives two different
overviews of one inbox, which is what this tool exists to prevent.

It ranks; it does not interpret. It reads the labels on the message, the label model as it stands
and the match history, and never the email's content, its Attention, the order labels were
created in or the order any tool returned them in. Given the same labels, the same current model,
the same history and the same ranking time, it answers the same way.

Call it once with every email's labels, in one batch:

```text
get_representative_labels   emails: [["Invoices", "Large amount", "Large invoice"],
                                     ["Newsletter", "Marketing", "Promotional newsletter"],
                                     ["Delivery"]]
```

One entry per email, **answered in the same order**, which is what keeps each answer with its
message. Pass label texts and nothing else. Each answer carries:

| Field | What it is |
| --- | --- |
| `representative` | the label this email is grouped under, or `null` when it has none |
| `secondary` | the email's other current labels, ranked, for the row's metadata |
| `unknown` | labels on the message that this account no longer defines |

## Grouping

- One section per distinct `representative`, headed with the **exact label text**. Never rename,
  generalise, shorten or combine a label, and never invent a heading above them.
- Order sections by how many emails they hold, most first, then by heading text ascending.
  Section order is a count, never the ranking that chose the headings.
- Two terminal sections take the emails whose `representative` is `null`, and they are
  **presentation only — neither is an Inbox Labeler label**:
  - **`Unknown labels`** — the message carries business labels, but this account defines none of
    them any more. Say in the report that these are historical labels, not a classification.
  - **`No match`** — the message carries no business label at all. This is the narrow, existing
    meaning of no-match: nothing matched it.
- An email with a `representative` is always in that label's section, however many `unknown`
  labels it also carries.
- `IL/processed` and `IL/no-match` are Inbox Labeler's own state, and are never a heading.

## Secondary labels

The representative label decides the section, the heading and the meaning. Everything else the
email carries is shown **on the row** as quieter metadata: `secondary` first in the order it came
back, then anything in `unknown`.

- show all of them, and **preserve the exact stored label text**
- never show the representative label again among them
- never show `IL/processed` or `IL/no-match`
- **never let a secondary label affect grouping**
- never hide a detection label because it fed the derived label in the heading — that it
  contributed is exactly what the row is showing

This is where an attribute earns its place. The heading answers *what is this email*; the
secondary labels answer *what else is true about it* — `Action required`, `Imminent`,
`Large amount`, `Discount`, `Informational`.

## Step zero: reach the MCP server

1. **Call `get_labels`.** That is the store; there is nothing local and nothing to load first.
2. **It returns labels, or an empty list.** Either way, **continue.** An empty model does not
   mean there is no processed mail: labels can have been deleted since, and mail can have been
   processed to `IL/no-match`. Those messages are still eligible and still belong in the
   overview.
3. **The call fails** — the MCP server is unreachable, the session is not authenticated, or the
   call errors. **Report the error verbatim and stop.** Without it there is no ranking and no
   model, so an overview built anyway would be a list of Gmail labels pretending to be one.

## The run

1. Complete [step zero](#step-zero-reach-the-mcp-server).
2. Run `list_labels` and note the id of `IL/processed` and every `IL/` label's resolved Gmail
   name. **Create nothing here** — a label that does not exist in Gmail cannot be on a message,
   and creating Gmail labels belongs to processing.
3. Find candidate threads with `search_threads`, query
   `in:inbox is:unread label:<IL/processed id>` — pass the label *id*, not the display name. Use
   `pageSize: 50` and follow `nextPageToken` until the pages run out.
4. For each thread, call `get_thread` and pick out the messages that are in the inbox, unread and
   carry `IL/processed`. Gmail returns a whole thread when any one of its messages matches, so
   check every message and skip the ones that do not qualify.
5. **Read the labels already on the message.** Take its `labelIds`, keep the ones that resolve to
   an `IL/` name, and strip the prefix. Ignore `IL/processed` and `IL/no-match` — they are state,
   not meaning. Do not evaluate the email against any instruction and do not reconsider whether a
   label belongs there.
6. Call `get_representative_labels` **once**, with one entry per message, in message order. Keep
   each answer with its message by position.
7. Read the facts for each row **out of the message you already fetched** — subject, sender,
   snippet, and the body from `get_thread` when they are not enough. That is reading for display,
   not classification: no instruction is evaluated and no label changes.
8. Present it, [as richly as the host allows](#presenting-it).
9. Report how many messages the overview covers, how many sections it has, any message that could
   not be fetched, and anything that landed under `Unknown labels`.

## Presenting it

**Use the richest interaction the current host supports**, and let the behaviour below decide
whether a host is rich enough — not a particular framework, API or widget.

- If the host can render an interactive selection — checkboxes on rows and on section headings,
  a running count of what is selected, actions at the end — use it.
- If it cannot, present the overview as readable grouped text, and let the user say which rows
  they mean in ordinary conversation.

Either way:

- **Never show a Gmail message id, and never ask the user to handle one.** Rows are identified by
  what they say — the sender, the amount, the subject — and by the section they are in.
- Keep the mapping from each visible row to its Gmail message yourself, privately.
- Link a row to its message in Gmail where the host can render a link, and where it can, make
  following the link and selecting the row two different actions.
- Nothing is selected to begin with.

The interaction has to accomplish the behaviour; this skill does not prescribe how a host
implements it. Do not invent a command grammar, do not ask the user to paste anything back, and
do not fall back to a protocol of your own.

## Marking messages read

The one action, and the only Gmail write in this skill.

It happens **only after the user explicitly asks for it**, about messages from the overview in
front of them — a selection they made, or messages they identified in conversation. Never on
render, never on selection, never because a row looks uninteresting, and never as a tidy-up at
the end of a run.

Then:

1. Resolve exactly the rows the user identified to their Gmail messages, from the overview you
   are holding. **Exactly those** — never the section they sit in, never everything shown, never
   a message from an earlier overview.
2. Clear `UNREAD` on them with `unlabel_message`, and report what changed. A message that is
   already read is left alone.

**If you cannot tell exactly which messages are meant — the request is ambiguous, or it refers to
an overview that has since been rebuilt — ask, and change nothing.** Widening an unclear request
to a whole section is the failure this rule exists to prevent.

## The labels on the mail stay as they are

Overview shows the classification a processing run recorded. **It does not reclassify, and it
does not backfill.** The `IL/` labels on a message are exactly what processing put there, and
this run leaves every one of them alone.

The ranking, though, reads the model **as it stands now** — the same way
`inbox-labeler-attention` reads the current `attention`. Editing a derived label's references, or
a detection label's role, can therefore move an already-labelled message into a different section
the next time an overview is built, while its Gmail labels do not change at all. That is this
view answering today's model, not classification reaching backwards, and it is worth saying
plainly if a user asks why a message moved.

For the same reason, a derived label's specificity is measured against the references it has
**today**: how many of them are on the message now. It is not a record of what took part when the
message was processed — nothing keeps that — so do not describe it as one.

## Boundaries this run must not cross

- **It never classifies.** No detection stage, no derived stage, no instruction evaluated, no
  label reconsidered. It reads the email only for the facts a row shows.
- **It never touches an `IL/` label, in either direction** — no adding, no removing, not even
  `IL/processed`.
- **It never calls `record_matches`**, `create_label`, `update_label` or `delete_label`.
  Recording belongs to processing, and label configuration to `inbox-labeler-manage`.
- **It never stars, archives, deletes, spams or replies**, and it never creates a Gmail label.
  Starring is `inbox-labeler-attention`'s, and so is marking mail read on Attention's own terms.
- **It never touches mail without `IL/processed`**, mail outside the inbox, or mail that is
  already read.
- **It sends nothing about a message to the MCP server** — no id, no subject, no sender, no
  snippet, no body.
- If a Gmail tool is unavailable, say which messages you could not reach and show the overview
  for the rest; never invent a row and never substitute a different action.
- One failing message is not a failing run: report it and carry on with the rest.
