---
name: inbox-labeler-process
description: Process new unread inbox emails using Inbox Labeler labels and Gmail. Classifies eligible messages with detection and derived labels, applies IL/* labels, marks them IL/processed, and records anonymized match counts.
---

# Inbox Labeler — process

One job: classify **new unread inbox mail** against the labels Inbox Labeler holds, apply the
resulting Gmail labels, and record what matched. Nothing else. Creating, renaming and deleting
labels is a different job, and so is acting on Attention — see `inbox-labeler-attention`.

**Two connections do different things.** Inbox Labeler's MCP server holds the labels and the
match history and has no access to the mailbox; Gmail holds the mail. Never look for labels in
Gmail and never look for mail in the MCP. `get_labels` and `record_matches` are the MCP's;
`list_labels`, `create_label`, `update_label`, `search_threads`, `get_thread` and
`label_message` are Gmail's. Identity is the authenticated MCP session — never ask the user for
an account id and never pass one to any tool.

## Scope

A **message** is the unit of work — never a thread. Only unread inbox messages are ever touched,
so archived mail and read mail are out of scope. `IL/processed` records that a message was
evaluated and `IL/no-match` records that the evaluation produced no matches. Unread is only a
scope filter — **never change the unread state** (no marking as read) and never treat unread as
the processing state.

**The absence of `IL/processed` is never sufficient on its own.** A message qualifies only when
it is in the inbox **and** unread **and** lacks `IL/processed`.

## What a label is

Each label names an aspect of a message and carries the fields `get_labels` returns:

| Field | Meaning |
| --- | --- |
| `label` | the label's text, which is its whole identity |
| `type` | `detection` or `derived` |
| `role` | *detection only* — `category` or `attribute`. May be absent on an older label |
| `attention` | `none`, `normal` or `high` — carried for `inbox-labeler-attention`, unused here |
| `instruction` | how to decide whether it applies, in natural language |
| `required_labels` | *derived only* — detection labels that must **all** have matched |
| `recommended_labels` | *derived only* — detection labels offered as context |

**Detection labels recognise facts. Derived labels interpret those facts.** A detection label
reads the email and decides. A derived label does not rediscover the email: it reads the email
*together with the detection labels that already matched* and decides what that combination
means.

**A detection label's `role` says what kind of fact it is, and changes nothing about how it is
decided.** A `category` names a kind of mail — `Invoice`, `Delivery`, `Travel`. An `attribute`
names something the mail contains, indicates or requires — `Deadline`, `Large amount`,
`Action required`. Read it as context when a derived label needs to know what a matched fact
*was*; do not read it as an instruction to this run. Specifically:

- Neither role is exclusive. A message may match several categories and several attributes, and
  every one of them contributes its Gmail label.
- There is no primary category and no primary attribute. Nothing here picks one.
- A message is not required to match a category, or an attribute, or one of each. Matching
  nothing at all is a normal outcome.
- `IL/no-match` still means no *detection* label matched, whatever their roles.
- A label with no role is a label modelled before the distinction existed. Evaluate it exactly as
  any other detection label; never infer a role for it, and never treat its absence as a reason to
  skip it or to label it differently.

`label` holds the label only. `IL/` is Inbox Labeler's Gmail namespace, added only when talking
to Gmail: **`Delivery arriving soon` resolves to the Gmail label `IL/Delivery arriving soon`,
spaces and all.**

## Labels are timeless

> **Evaluate every label as if you were reading the email at the moment it was written.**

- The current date and the current time never influence whether a label applies. Neither does
  how long ago the email arrived.
- A relative date inside the email — "tomorrow", "in one hour", "next Tuesday" — is a fact
  *about the email*. Read it against the email's own date, never against now.
- The same email gets the same labels whether it is processed a minute after it lands or five
  years later.

## Step zero: make sure labels are available

**The run starts here.** Processing without labels is meaningless, so before touching a single
message, establish that they exist.

1. **Call `get_labels`.** That is the store; there is nothing local and nothing to load first.
2. **It returns labels.** Continue with the flow below. These are the labels this run uses —
   never a remembered set, never an earlier run's.
3. **It returns an empty list.** **Stop.** Tell the user plainly that no labels are configured
   and offer to create some. Do not process anything and do not invent a starter set.
4. **The call fails** — the MCP server is unreachable, the session is not authenticated, or the
   call errors. **Report the error verbatim and stop.** Do not fall back to an empty list, do
   not process part of the inbox, and do not guess at labels.

*Nothing configured* is a normal state with an obvious next action; *something broken* must
never be silently treated as *nothing there*, because that would relabel a mailbox from an empty
rulebook.

## Every run handles at most ten messages

**A run processes no more than ten messages, and then stops.** Fewer is fine: if only three are
eligible, a run handles three; if none are, it handles none. Everything beyond the tenth is left
alone.

**Ten is a hard maximum, not a target.** Never widen the query, never continue into read mail,
and never take a message that fails the per-message check in order to reach ten. When the search
results run out, the run is over.

The limit changes *how many* messages a run touches, never *which* ones. Selection, ordering and
the per-message rules are untouched — the run simply ends early.

Nothing is needed to keep the rest for later. An unhandled message never received
`IL/processed`, so it is still in scope exactly as it was, and the next run continues in the same
order. There is no cursor to keep and no state to write.

Always say how many you handled and whether more remain, so the user knows another run is worth
it.

## The run

1. Complete [step zero](#step-zero-make-sure-labels-are-available). Then resolve each label to
   its Gmail name — `Large amount` → `IL/Large amount` — and work with the resolved names from
   here on; Gmail knows nothing about the unprefixed form.
2. Run `list_labels` and note the ids of `IL/processed`, `IL/no-match` and every resolved
   business label, together with each business label's current Gmail color where it already
   exists. Create any that are missing with `create_label`, passing the resolved name and the
   color for what that label is from the table in
   [Gmail label colors](#gmail-label-colors) (the `IL` parent is created automatically); create
   `IL/processed` and `IL/no-match` with no color, since they are not business labels. For a
   business label that already exists, compare its current color to that table's value and call
   `update_label` only when they differ — this is also where an existing label's color catches up
   after its role was settled or changed.
3. Find candidate threads with `search_threads`, query
   `in:inbox is:unread -label:<IL/processed id>` — pass the label *id*, not the display name.
   If you just created `IL/processed`, `in:inbox is:unread` is equivalent. Use `pageSize: 50`.
4. **Work through the pages in order, and stop at ten messages.** Keep calling `search_threads`
   with the returned `nextPageToken` while you still need messages; once ten have been processed,
   stop and fetch no further page. If the pages run out first, you are done — fewer than ten is
   fine, and so is none. Narrow the query only if the user explicitly asked for a narrower scope
   (e.g. "everything from today" → add `newer_than:1d`). That is selection; it does not change
   what any selected message means.
5. For each thread, call `get_thread` and pick out the individual messages that are in the
   inbox, unread, and lack the `IL/processed` id in `labelIds`. Gmail returns a whole thread
   when any one of its messages matches, so a result can mix in-scope and out-of-scope
   messages — check every message and skip the ones that do not qualify. Take them in the order
   the search returned them and count only the ones you actually process against the ten.
6. **Detection stage.** For each in-scope message, work through the whole list of detection
   labels and decide each one independently, keeping the ones whose aspect is present. **The
   label's `instruction` is the rule** — it is read as a prompt, not matched as a pattern, and
   it is the whole of what decides. Never classify from a label's name, never add criteria of
   your own, and never pick a single best label: every label gets its own MATCH or NO MATCH, and
   any number of them may match. A label's `role` takes no part in that decision — a category and
   an attribute are judged the same way, by their own instructions. Subject, sender and snippet are usually enough; use the full
   body from `get_thread` when they are not. The result is the complete set of triggered
   detection labels — empty, one, several, or all. Note one short reason per match: that is the
   **evidence**, and the derived stage needs it.
7. Apply the detection outcome with `label_message`, which branch depending on whether the set
   is empty:
   - **At least one detection label triggered** — apply the resolved business label of every
     triggered label.
   - **No detection label triggered** — apply `IL/no-match`.
8. **Derived stage**, only after the detection stage has finished for that message. Evaluate
   every derived label against the message, using the detection result as context — see
   [The derived-label prompt](#the-derived-label-prompt). Apply the resolved business label of
   each derived label that triggered. Skip a derived label whose `required_labels` did not all
   match; that is not a failure, it simply does not apply here. One derived label's outcome is
   never input to another.
9. Apply `IL/processed` last, once both stages finished and every business label is in place.
   If either stage is incomplete or a labelling call fails, leave `IL/processed` off so the
   message is picked up again on the next run.
10. **Record what matched.** Every message this run labelled gets one call, once it is fully
    labelled — this step is part of every run and is never skipped:

    ```text
    record_matches   labels:          [<each business label applied>]
                     email_timestamp: <the message's own timestamp>
    ```

    One call per message, naming every business label that matched it — detection labels and
    derived labels alike, without their `IL/` prefix. A label that did not match is not passed.
    `IL/no-match` and `IL/processed` are Inbox Labeler's own state rather than labels, and are
    never recorded. A message that got `IL/no-match` matched nothing, so it has no call.

    **The timestamp is the email's own, not the moment you are running.** A message written in
    March counts towards March. Give it with a UTC offset — `2026-08-20T10:12:00Z` or
    `2026-08-20T12:12:00+02:00`; without one it is refused rather than guessed.

    **Pass the label names and that timestamp, and nothing else.** Not the subject, the sender,
    the recipients, the body, the message or thread id, or anything about an attachment: the
    store keeps counts, not mail. Nothing in it identifies an email, so a message reported twice
    is counted twice — report each one once.

    If a `record_matches` call fails, **say so in the summary and carry on**. Recording is
    bookkeeping and does not decide anything: the classification stands, the Gmail labels stay as
    they are, and the message keeps its `IL/processed`. Do not evaluate the message again and do
    not re-apply labels that are already on it in order to retry the bookkeeping — that would
    change the mailbox to fix a counter. Say which messages went unrecorded and why.
11. Report a short summary: how many messages were processed, which message got which business
    labels and why, which got `IL/no-match`, any failures, and anything you were unsure about
    instead of guessing silently. Say which labels came from interpretation when a derived label
    triggered. When a derived label's `required_labels` all matched but the interpretation
    rejected it, say so and explain briefly why. **If the run stopped at the ten-message limit,
    say so** and that another run will continue with the rest — otherwise the user has no way to
    tell a finished inbox from a truncated run.

## The derived-label prompt

When you evaluate a derived label, give yourself exactly four things:

1. **the email** — sender, subject, and enough body to judge
2. **the detection labels that matched** — only the ones that matched, never the ones that did
   not
3. **the evidence** for each of those matches — the one-line reason noted in the detection stage
4. **the derived label's instruction**

Nothing else. Lay them out in three sections — `Email`, `Detection Results`, `Task`:

```text
Email

From:    billing@stripe.com
Subject: Your invoice INV-4021 is due
Body:    … 1,450.00 EUR due on 12 August …

Detection Results

Invoice
Evidence: states "invoice INV-4021" with an amount due

Large amount
Evidence: 1,450.00 EUR, over the 100 threshold

Task

Determine whether the following Derived Label applies.

Label:
Large payment needs attention

Instruction:
A payment this large should be looked at before it is due.

Answer yes or no and explain briefly.
```

One derived label per prompt. `Detection Results` lists only labels that matched, each with its
evidence; if none matched, the section says so rather than listing anything.
`recommended_labels` are context, not a gate: include the ones that matched, and when none did,
evaluate the label anyway.

Treat the listed detection labels as established facts and reason from them — do not re-check
whether the email really is an invoice. The email is there for the details the labels do not
carry, like the due date. Read those details as they stood when the email was written.

## Gmail label colors

What a label **is** decides its business label's **Gmail color** — presentation only. Take it
from this table and never choose a color by hand:

| Label | `backgroundColor` | `textColor` |
| --- | --- | --- |
| detection, `role: "category"` | `#fce8b3` | `#000000` |
| detection, `role: "attribute"` | `#fef1d1` | `#000000` |
| derived | `#efa093` | `#000000` |
| detection with no `role` | `#cccccc` | `#000000` |

These are tiles from Gmail's own label palette rather than free choices, so pass them exactly as
written — Gmail refuses a color that is not one of its own. They are two families and a
neutral: detection warm, with a category the deeper amber of it and an attribute the lighter,
derived a coral beside them, and a role-less label plain grey. The website shows a label in the
same four, one hierarchy on two palettes; the values differ because the palettes do, and neither
side reads the other.

**Attention has nothing to do with a color.** A `category` is the same amber whether it asks for
`high`, `normal` or `none`, and so for the other three rows. `attention` is still part of every
label's configuration and still arrives with it from `get_labels` — it is simply not what a Gmail
color encodes. What a label asks of you is carried out on the *message* by
`inbox-labeler-attention`.

A label with no `role` is grey because nobody has settled what it is, not because it asks for
nothing. Settling the role is a modelling decision for `inbox-labeler-manage`; this run reads the
role it finds and never fills one in.

Colors are written in step 2 and nowhere else. Compare before writing: **matching already → do
nothing**. `IL/processed` and `IL/no-match` get no color, because they are not business labels and
have no role or type of their own. If a color update fails, say which Gmail label could not be
recolored and continue with the rest.

## Rules while processing

- **No labels, no processing.** Never touch a message before step zero has produced labels. An
  empty rulebook does not mean "nothing matches" — it means the run should not have started, and
  treating the two alike would mark real mail as `IL/no-match`.
- **Detection first, derived second, always.** A derived label is never evaluated before the
  detection stage has finished for that message, because its input is the detection result.
- **Judge every message as of the day it was written.** Neither stage consults the current date
  or time. The only time-dependent choice in a run is which messages to select, and only when the
  user asked for a narrower scope.
- **Every message goes through the full list.** Each detection label gets its own decision for
  that message, and each one that triggers contributes its Gmail label.
- **`IL/no-match` reflects the detection stage.** A processed message carries either at least one
  detection business label or `IL/no-match`, never both. Derived labels do not affect it.
- **`IL/processed` is always last and always earned.** Never leave it on a message whose
  evaluation did not complete successfully.
- **Labelling only ever adds.** This run removes no label from any message, inside the `IL/`
  namespace or outside it. Gmail's own labels (`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`,
  `CATEGORY_*`) and every user label are read-only to it. **Never add or remove `STARRED`, never
  add or remove `UNREAD`**, never archive, delete, or reply — labelling is its entire job.
  `STARRED` and `UNREAD` belong to `inbox-labeler-attention`, and to nothing else.
- **Never stop for the wrong reason.** Ten messages is the only limit. Within a run, size is
  never a reason to pause: do not sample, do not ask for confirmation because the inbox is large,
  and do not cut a message short because it triggered many labels.
- One failing message is not a failing run: report it and continue with the rest.
- If Gmail tools are unavailable, do not fake it: report which messages you cannot reach and
  present the labelling decisions as a plan, applying nothing.
