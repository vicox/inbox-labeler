---
name: inbox-labeler-mcp
description: Classify inbox messages against the label policy held by the hosted Inbox Labeler MCP, decide how much attention each message deserves, and record what matched. Use when the user asks Inbox Labeler to process or label their inbox, to apply attention, or to create, change, list or delete labels. This is the hosted version: the MCP holds the policy and the history, and no local files are involved.
---

# Inbox Labeler

## Purpose

Inbox Labeler holds a **label policy** — user-defined labels, each naming an aspect of a
message worth noticing — and applies it to the user's mail on request.

Three workflows, kept apart:

| Workflow | What it does | When it runs |
| --- | --- | --- |
| **Process labels** | classify unread inbox messages that are not already processed, against the policy | the user asks to process or label the inbox |
| **Apply attention** | act on what the policy implies for already-classified mail | only when the user asks |
| **Update matches** | record matched labels for successfully handled messages | inside processing, when reliable processed-marker capability exists — never asked for |

Editing the policy is a **fourth, separate** workflow. Processing never changes the policy, and
changing the policy never touches mail.

Nothing is scheduled. Every run happens because the user asked for it.

## Preconditions

**The Inbox Labeler MCP is not enough on its own.** It holds the label policy and the match
history — and nothing else. **It has no access to the user's email account.** Two connections have
to be in place, and they do different jobs:

| | Provides |
| --- | --- |
| **The mail system** | the messages, and the mailbox actions taken on them |
| **The Inbox Labeler MCP** | the label policy, and the match history |

This skill only says how to combine them. Without the mail connection there is nothing to
classify; without the MCP there is nothing to classify *against*.

**So the user's mail system must be connected to this agent separately.** For Gmail, that means
Gmail must be connected with the mail permissions below. Another mail system works too, as long as
it can do the same things.

### What the mail connection has to be able to do

**To process an inbox at all:**

- read inbox messages
- tell whether a message is **in the inbox** and whether it is **currently unread** — both are part
  of what makes a message eligible; see [step 3](#3-select-the-messages-to-process)
- inspect the mailbox labels already on a message, and the mailbox labels that exist
- create Inbox Labeler's mailbox labels in the `IL/` namespace
- apply those labels to messages

**Strongly preferred:** applying several labels to a message in **one** operation. A message's whole
Inbox Labeler state goes on as one commit, and fewer writes means fewer ways for it to end up half
applied. **It does not by itself make the change all-or-nothing** — that depends on what the mail
system guarantees. Where only separate writes are available, processing still works. Both cases,
and how to tell what actually happened, are in
[step 8](#8-commit-the-mailbox-state-then-record-what-matched).

**To apply attention, additionally:**

- star a message
- mark a message as read

**Optional:** setting a mailbox label's colour. Where the mail system does not support colours,
everything else still works — colour never blocks anything.

### When a connection is missing or limited

- **The Inbox Labeler MCP is unreachable** → stop and say so. **Never classify from a remembered,
  cached or stale policy**, from an earlier run, or from a file.
- **Mail cannot be read** → inbox processing cannot run. There is nothing to work on.
- **Mail can be read, but the mailbox-label capability is missing altogether** — `IL/` labels cannot
  be created or applied at all → classification may be presented as a plan, but the messages are
  **not** processed and no history is recorded. [Step 2](#2-prepare-the-mailbox) decides this and
  [Failure, retry and consistency](#failure-retry-and-consistency) states what follows. A
  *single* label that fails while the capability itself works is a narrower case, handled in those
  same two places.
- **Starring or marking read is unavailable** → processing is unaffected. Only the corresponding
  [Apply attention](#apply-attention) actions cannot be carried out, and that has to be reported
  rather than worked around.

**Identity is the authenticated MCP session.** Never ask the user for an account id and never pass
one to any tool.

### Two sets of tools share names

Inbox Labeler's MCP exposes `create_label`, `update_label` and `delete_label`. A mail connector
usually exposes something similarly named for **mailbox** labels. They are different things, and
confusing them writes to the wrong place.

Throughout this document, `get_labels`, `create_label`, `update_label`, `delete_label`,
`get_matches` and `record_matches` **always mean Inbox Labeler's MCP tools and always act on the
policy**. Anything to do with the mailbox is described in prose — "apply the mailbox label",
"search the inbox".

## Core workflow

### 1. Load the label policy

**Call `get_labels` first, on every run.** What it returns is the policy, complete and
authoritative:

| Field | Meaning |
| --- | --- |
| `label` | the label's text, which is its whole identity |
| `type` | `detection` or `derived` |
| `attention` | `none`, `normal` or `high` |
| `instruction` | how to decide whether it applies, in natural language |
| `required_labels` | *derived only* — detection labels that must **all** have matched |
| `recommended_labels` | *derived only* — detection labels offered as context |

**An empty policy means stop.** It does not mean "nothing matched". Say that no labels are
configured and offer to create some. Never invent a starter set, and never classify against an
empty rulebook — that would mark real mail as having matched nothing.

Never carry a policy between runs and never classify against labels you remember. The policy read
at the start of a run is the one that run uses.

### 2. Prepare the mailbox

Once per run, after `get_labels` and before any message is touched.

**Establish that the processed marker works.** Three things have to hold:

1. `IL/processed` can be **read** reliably, so a message that has already been handled can be
   recognised as such.
2. The `IL/processed` mailbox label **exists, or can be created** successfully.
3. The mail system is able to **apply** it to a message.

**If all three hold, processing proceeds normally.**

**If any of them cannot be established, this run does not process anything.** Classification may
still be offered — read the mail, evaluate the policy, determine attention, and present the result
**as a plan** — but in that mode:

- do **not** apply semantic mailbox labels
- do **not** call `record_matches`
- do **not** describe any message as processed

Say which of the three could not be established, so the user knows what to fix.

**Bring the mailbox labels in line with the policy.** Still once per run, walk the **complete** set
of labels `get_labels` returned and, where the mail system supports it:

- ensure each label's `IL/<label>` mailbox label exists, creating it if it does not
- compare its colour with the colour derived from that label's `attention`
- update a colour that no longer matches

See [Colour follows attention](#colour-follows-attention) for the mapping and for why a colour
never blocks anything. This is where an attention level that changed since the last run catches up,
and it is the **only** place colours are written.

Ensure `IL/no-match` exists here too. It and `IL/processed` are state, not labels, and get no
colour.

**A semantic label that could not be created here does not stop the run.** Report which one failed,
and carry on with messages that do not need it. If a later message does need it, repeat this
preparation for that one label at the point of use — ensure the mailbox label exists, synchronise
its colour from the policy label's `attention` where colours are supported, then apply it. That
retry is recovery for a label whose preparation failed; it is not a second place where colours are
routinely synchronised.

If the retry fails as well, the message is handled by
[Failure before the mailbox commit](#a-failure-before-the-mailbox-commit).

**Create nothing outside `IL/`**, and never rename, recolour or otherwise modify a mailbox label of
the user's own.

### 3. Select the messages to process

**During normal processing, consider only messages that are currently in the inbox, are currently
unread, and do not carry `IL/processed`.** This is the authoritative eligibility rule; everywhere
else in this document refers here. All three conditions are required:

| Condition | What it establishes |
| --- | --- |
| in the **inbox** | mail the user has not filed or archived away |
| currently **unread** | **scope** — mail the user has not dealt with yet |
| no **`IL/processed`** | **completion** — work Inbox Labeler has not already done |

**A message failing any one of them is skipped.** It is not classified, receives no semantic `IL/`
label, no `IL/no-match` and no `IL/processed`, and is never recorded.

**Unread and `IL/processed` are different things and neither substitutes for the other.** Unread is
a **scope filter**; `IL/processed` is a **processing state**. They answer different questions, which
is why both are required:

- A **read** message with no `IL/processed` is **out of scope**, deliberately. Inbox Labeler labels
  mail the user still has to deal with, and read mail has been dealt with. Normal processing never
  reaches back for it.
- An **unread** message carrying `IL/processed` is **out of scope for normal processing**, because
  the work is finished. That message is what [apply attention](#apply-attention) works on.

**Processing never changes a message's read state.** Marking read belongs to apply attention and to
nothing else.

#### Narrow the search where the mail system can

Ask the mail system for candidates that are already in the inbox, unread and without `IL/processed`,
using whatever its search supports. **Narrowing the search is an optimisation, never the
guarantee** — the per-message re-check below is what actually enforces eligibility, including on a
mail system whose search cannot express one of the three conditions at all.

Gmail, as **one example** of what that looks like:

```text
in:inbox is:unread -label:<the IL/processed mailbox label>
```

Some Gmail connectors want that label's **id** rather than its display name; use whichever the
connected one accepts. **This is an illustration, not the interface.** Another mail system expresses
the same three conditions in its own syntax, and one that cannot express them at all is handled
entirely by the re-check below.

The user may narrow selection further — "everything from today" — and that is selection, not
meaning: it changes which messages are considered, never how any of them is judged.

#### Re-check every message individually

**A search result is a suggestion; the message itself is the authority.** Mail systems return
thread-shaped results, so one matching message can bring along others that do not qualify, and a
message's state can change between the search and the moment it is reached.

**Immediately before processing each individual message, re-check all three conditions on that
message:**

1. Is it **in the inbox**?
2. Is it **currently unread**?
3. Does it **lack `IL/processed`**?

**Only if all three are true may that message be processed.** If any one is false, skip it: do not
classify it, do not apply a semantic `IL/` label, do not apply `IL/no-match`, do not apply
`IL/processed`, and do not call `record_matches`. A skipped message does not count against the
run's limit — see [Bound each run](#bound-each-run).

Steps 4 to 8 below then run for each message that qualified, one message at a time.

### 4. Evaluate detection labels

For each message, work through **every** detection label and decide each one **independently**.
Whether a label applies depends on exactly two things: the message, and that label's own
`instruction`.

- **The instruction is authoritative.** Never classify from a label's name when an instruction
  exists. `Login` means whatever its instruction says it means.
- Subject, sender and a snippet are usually enough; read the full body when they are not.
- The result is the complete set of labels that applied — none, one, several, or all.
- **Note one short reason per match.** That is the **evidence**, and the derived stage and the
  summary both need it.

### 5. Evaluate derived labels

Only after the detection stage has finished for that message.

A derived label does not rediscover the message. It reads the message **together with the
detection labels that matched** and decides what that combination means.

- **Skip a derived label whose `required_labels` did not all match.** That is not a failure; it
  simply does not apply to this message.
- **`recommended_labels` never gate anything.** Include the ones that matched as context; when
  none did, evaluate the label anyway.
- A derived label with **no** `required_labels` is evaluated for every message.
- Derived labels never reference other derived labels, and one derived label's outcome is never
  input to another.
- **A derived label may say no.** The required labels decide which messages are considered; the
  instruction decides which of those the label belongs on. Rejecting a message whose gate matched
  is the interpretation doing its job — report it.

Give yourself exactly four things per derived label, and nothing else:

```text
Email

From:    billing@example.com
Subject: Your invoice INV-4021 is due
Body:    … 1,450.00 EUR due on 12 August …

Detection Results

Invoice
Evidence: states "invoice INV-4021" with an amount due

Large amount
Evidence: 1,450.00 EUR, over the threshold

Task

Determine whether the following derived label applies.

Label:       <label>
Instruction: <its instruction>

Answer yes or no and explain briefly.
```

One derived label per evaluation. `Detection Results` lists only labels that matched, each with
its evidence; if none matched, say so rather than listing anything. Treat those labels as
established facts — do not re-check whether the message really is an invoice. The email is there
for details the labels do not carry, like a due date.

### 6. Determine attention

Attention is **not a label**. It is what a label asks of the user, declared per label and computed
per message. It is never stored on a message.

| Level | What the label is saying |
| --- | --- |
| `none` | the user never needs to see this |
| `normal` | *(the default)* leave it alone |
| `high` | important, and stays important |

**The highest-priority level among the labels a message carries wins, ranked
`high` > `none` > `normal`:**

1. any matched label at `high` → **high**
2. otherwise, any matched label at `none` → **none**
3. otherwise → **normal**

`normal` loses to both because it is the *absence* of a request — what a label gets when nothing
was said. A label that does ask for something outranks it, and asking for attention outranks
asking for none. So a message carrying `Invoice` (`normal`) and `Newsletter` (`none`) comes out
**none**: the one label with an opinion is the one that has it.

A message with no matched labels comes out `normal`, so it is left alone.

This is Inbox Labeler's policy. **Do not invent a different priority scheme**, do not weight by
how many labels matched, and do not let your own reading of a message override it.

### 7. Present or act on the result

Attention decides prioritisation and presentation. It **never** causes a label to be invented.

When presenting mail, order by attention — `high` first, then `normal`, then `none` — and say
which labels produced each level. During processing, reporting the level is enough; changing
mailbox state is the separate **apply attention** workflow.

### 8. Commit the mailbox state, then record what matched

**This is the authoritative per-message sequence.** Nothing else in this document restates it;
everywhere else refers here.

```text
1  classify detection labels                                     (step 4)
2  evaluate derived labels                                       (step 5)
3  determine attention                                           (step 6)
4  determine the complete set of IL/ labels this message needs
5  MAILBOX COMMIT — establish that whole set, IL/processed included
6  call record_matches, if any semantic label matched
```

**The mailbox is the primary operational state; match history is secondary bookkeeping.** That is
what fixes this order: `IL/processed` is established *before* anything is recorded, so a message
whose matches have been counted can never look unprocessed to a later run.

**Step 4 — the complete set.** Work out everything this message needs before writing anything:

- every semantic label that matched, as `IL/<label>` — detection and derived alike
- `IL/no-match`, when no detection label matched
- `IL/processed`, always

The label texts in the policy never carry a prefix; `IL/` is added only when talking to the mailbox,
so `Large amount` becomes the mailbox label `IL/Large amount`, spaces and all. Every label in the set
must already exist before the commit is attempted — normally from
[step 2](#2-prepare-the-mailbox), and otherwise by repeating that label's preparation as described at
the end of step 2.

**Step 5 — the mailbox commit.** Establish that whole set on the message before anything is
recorded. `IL/processed` belongs to this phase, not to a step after it.

**Prefer one operation where the mail system supports applying several labels at once:**

```text
apply ["IL/Invoice", "IL/Large amount", "IL/processed"]
```

**But accepting several labels in one call is not a guarantee that they are applied together.**
Treat such an operation as atomic **only where the connected mail system explicitly guarantees
atomicity**. Absent that guarantee, one call can still leave the message partly labelled, and a call
can succeed while its response is lost.

**Where no multi-label operation exists, write them separately, and in this order:**

```text
1  every required semantic label  IL/<label>
2  IL/no-match, when applicable
3  IL/processed  — last within the mailbox phase
```

`IL/processed` goes on **after** the labels it vouches for, so a message that carries it is a
message whose semantic labels are already there. Writing it earlier would produce a message that
looks processed while it is not, and normal processing skips such a message rather than fixing it.

Putting `IL/processed` last **within the mailbox phase** is not the old model: recording still
happens after the mailbox is complete, never between the semantic labels and the marker.

**After any mailbox operation that failed, or whose outcome is unclear, and where atomicity is not
guaranteed: re-read the message's current Inbox Labeler mailbox labels before deciding what
happened.** The write's return value is not evidence about the mailbox; the mailbox is. What to
conclude from what you read is in
[The mailbox commit did not clearly succeed](#b-the-mailbox-commit-did-not-clearly-succeed).

**Step 6 is one `record_matches` call**, made only after the commit succeeded, naming every semantic
label that matched — detection and derived alike — with that message's own timestamp:

```text
record_matches(labels: ["Invoice", "Large amount", "Large payment needs attention"],
               email_timestamp: "2026-08-20T10:12:00Z")
```

- **The timestamp is the email's own, never the moment you are running.** A message written in March
  counts towards March. Include a UTC offset — `2026-08-20T10:12:00Z` or
  `2026-08-20T12:12:00+02:00`; without one it is refused rather than guessed.
- **Never name the same label twice in one call.** One email is one match per label; a repeated name
  is refused and the whole call fails.
- **No semantic matches, no call.** A message where no semantic label matched is not recorded — it
  still got its `IL/no-match` and `IL/processed` in the commit. The markers are Inbox Labeler's own
  state, not labels, and are never recorded as matches.
- **Pass label names and the timestamp, and nothing else.** Not the subject, sender, recipients,
  body, message or thread id, or anything about an attachment. Inbox Labeler keeps counts, not mail.

When any of these steps does not succeed, see
[Failure, retry and consistency](#failure-retry-and-consistency). That section is the only place the
consequences are stated.

### Colour follows attention

A semantic label's mailbox colour is fixed Inbox Labeler presentation, derived from that policy
label's `attention`. The MCP does not store it and it is never a second source of truth.

| `attention` | `backgroundColor` | `textColor` |
| --- | --- | --- |
| `none` | `#cccccc` | `#000000` |
| `normal` | `#fce8b3` | `#000000` |
| `high` | `#efa093` | `#000000` |

- **Colours are written in [step 2](#2-prepare-the-mailbox) and nowhere else** — on creation, and on
  a label whose attention level has changed since the mailbox label was made.
- **Compare before writing.** A colour that already matches needs no call, which is what keeps
  repeated runs idempotent.
- **The state markers get no colour.** `IL/processed` and `IL/no-match` are Inbox Labeler's own
  state, not something an attention level describes.
- **Never pick a colour by hand** and never invent one for a level. These three rows are the whole
  mapping.
- **Colour never blocks anything.** Where the mail system does not support label colours, carry on
  without them; where a colour cannot be set on a label that exists, name the label and continue.

## Failure, retry and consistency

**This is the authoritative failure section.** Every other part of this document refers here rather
than restating what a failure means.

### What is being protected, and in what order

1. **Correct mailbox state.**
2. **No duplicate processing, and no duplicate match counts.**
3. **Complete match history.**

In that order. **Losing a history update in an exceptional failure is acceptable. Making a
successfully processed message eligible for normal reprocessing in order to repair its history is
not.** Missing statistics are a smaller problem than a mailbox that gets relabelled and counted
twice.

Match history is additive, and Inbox Labeler stores **no message id and no idempotency key**, so
nothing on the server side can tell that a message has been recorded before. **`IL/processed` is the
whole of the protection** — which is why it is established in the commit, *before* anything is
recorded, and why [step 2](#2-prepare-the-mailbox) checks that it works before any message is
touched.

Two rules follow, and they are hard:

- **Never process or record a message that already carries `IL/processed`.** Check before doing
  anything else with it. A message that already has it is finished; leave it alone, including when
  its history might be incomplete.
- **Within one processing attempt, call `record_matches` at most once for that message.**

### A. Failure before the mailbox commit

Classification could not complete, or a required semantic label could not be prepared or created.

- Do **not** establish `IL/processed`.
- Do **not** call `record_matches`.
- Report the message as incomplete and say what failed.

The message is untouched as far as processing is concerned and stays eligible for the next run.

This covers a label whose creation already failed during [step 2](#2-prepare-the-mailbox) and failed
again when this message needed it. A failure in step 2 alone stops only the messages that need that
label, not the run.

**A colour that could not be set is not this case.** Name the label and carry on; see
[Colour follows attention](#colour-follows-attention).

### B. The mailbox commit did not clearly succeed

A mailbox write failed, or its outcome is unclear because the response was lost or the call timed
out.

**A failed or unclear write says nothing reliable about the mailbox.** Unless the mail system
guarantees atomicity and reported a clean failure, **re-read the message's current Inbox Labeler
mailbox labels** and decide from what is actually there. Never assume the write left no trace, and
never assume `IL/processed` is absent just because the call did not report success.

Three states, and they need different answers:

**State A — the complete required set is present, `IL/processed` included.**

The commit succeeded, whatever the response said. This is the ordinary shape of a lost response.

- Treat it as [C. The mailbox commit succeeded](#c-the-mailbox-commit-succeeded).
- Proceed to `record_matches` if any semantic label matched.
- Do **not** repeat the mailbox writes; there is nothing left to write.

**State B — `IL/processed` is absent.**

The commit is incomplete.

- Do **not** call `record_matches`.
- Report the partial mailbox state, naming which labels are present.
- **Do not claim anything was rolled back.** Semantic labels already applied stay applied.
- The message remains eligible for a later normal processing attempt, which will re-apply what is
  already there — harmless — and complete the commit.

**State C — `IL/processed` is present, but a required semantic label or `IL/no-match` is missing.**

**This is an inconsistent processed state, and it is the one failure that does not heal.**

- Do **not** call `record_matches`.
- **Report it prominently**, naming the message and exactly which labels are missing.
- Do **not** describe the message as safely processed.
- **Do not say a normal run will repair it.** It will not: normal processing skips anything carrying
  `IL/processed`, which is precisely why this state persists.
- Do **not** silently remove `IL/processed`, and do not invent a repair procedure.

**It needs explicit attention.** Say so plainly, and leave the decision — complete the labels by
hand, or remove `IL/processed` so a normal run can redo the message — to the user.

### C. The mailbox commit succeeded

Once the complete set is established, `IL/processed` included, **the message is processed** from the
mailbox's point of view. That is the state that counts.

Only now may match history be updated.

### D. `record_matches` definitely failed

The commit succeeded and the call was refused, with the refusal seen — a repeated label name, a
timestamp without an offset, a label the policy does not have.

- **The message stays processed.**
- Do **not** remove `IL/processed`.
- Do **not** remove any semantic label.
- Report that **mailbox processing succeeded and match-history recording failed**, with the reason.
- **A normal processing run must not pick this message up again to repair its history.**

This deliberately prefers a missing statistic over a message being processed twice.

### E. `record_matches` outcome is uncertain

The commit succeeded and the response was lost, the call timed out, or the connection dropped, so the
server may or may not have recorded.

- **The message stays processed.**
- **Report the match-history state as uncertain** — never as definitely failed, and never as
  definitely recorded.
- Do **not** retry the call automatically.
- Do **not** remove `IL/processed`, and do **not** make the message eligible for normal processing
  again.

The history may be there or may be missing, and that is accepted. Avoiding duplicate history matters
more than completing it.

### Missing marker capability

If the checks in [step 2](#2-prepare-the-mailbox) did not establish that `IL/processed` can be read,
created and applied, this run does not process anything: no semantic mailbox labels, no
`record_matches`, and no message described as processed. Classification may be presented as a plan.

Asking the user "has this been processed before?" is **not** a substitute for the marker; do not
offer it as one.


### Scope of a failure

**One failing message is not a failing run.** Report it and carry on with the rest.

## Label semantics

### Labels are identified by their text

A label's text is its **only** identifier — no separate name, no id. References name it exactly,
spaces included.

Inbox Labeler normalises a label's text before comparing or storing it: **leading and trailing
whitespace is trimmed, and internal runs of whitespace collapse to a single space**. Uniqueness is
then decided **ignoring case**, so `Delivery` and `delivery` are the same label, and
`"  Large   amount "` is the same label as `Large amount`. Lookups match either way. Use these same
rules whenever you compare a mailbox label's text against the policy.

Write labels as ordinary phrases that read naturally: `Delivery arriving soon`, not
`DeliveryArrivingSoon`. Capitalise the first word only, unless a word is a proper noun or an
acronym — `BVK`, `VIP customer`, `PDF invoice` keep their capitals.

### Labels are timeless

> **Evaluate every label as if you were reading the email at the moment it was written.**

- The current date and time never influence whether a label applies, and neither does how long ago
  the message arrived.
- A relative date inside the message — "tomorrow", "in one hour", "next Tuesday" — is a fact
  *about the message*. Read it against the message's own date, never against now.
- The same message evaluated twice yields the same labels. If an outcome differs, the policy
  changed — never the clock.

An email from last week saying "your package arrives tomorrow" can still correctly receive a label
about imminence, because the arrival *was* imminent when it was written.

**"Is this still relevant?" is a different question.** Labels like `Expired`, `Still open` or
`Needs attention today` compare a message against the clock and cannot be labels at all. If the
user asks for one, say so plainly and offer the timeless part instead: "payment due soon" can be
read off a message; whether that date has now passed cannot.

Time has one legitimate role, and it is upstream of evaluation: **choosing which messages to look
at.** "Everything from today" narrows selection, not meaning.

### Detection labels

*What can I directly observe in this message?* They recognise facts, and they are the default.

### Derived labels

*Given the message and the detection labels that matched, what does this mean?* They interpret
facts that detection already established.

### `required_labels`

An **AND gate**. Every one must have matched, or the derived label is not evaluated at all for that
message. Use it for observations that all have to hold.

### `recommended_labels`

**Context, not a gate.** Any subset may be present. Include those that matched when evaluating;
their absence never blocks anything.

Both lists hold plain label texts, both may be empty, and both may **only** name detection labels.
There is no chaining from one derived label to another.

## Batch and inbox processing

### One message at a time

The unit of work is a **message**, never a thread. A mail search may return a whole thread when any
one of its messages matches, so **re-check each message's own eligibility before processing it** —
in the inbox, unread, no `IL/processed` — and skip the ones that fail, exactly as
[step 3](#3-select-the-messages-to-process) requires. Classify a message completely — steps 4 to 8
above — before moving to the next.

### Scope and the two markers

Normal processing is scoped to messages that are **in the inbox, unread, and without
`IL/processed`**. The rule and its enforcement are [step 3](#3-select-the-messages-to-process); this
section is about what the two markers mean.

| Marker | Meaning |
| --- | --- |
| `IL/processed` | Inbox Labeler has finished evaluating this message |
| `IL/no-match` | **no detection label matched** this message |

**Only `IL/processed` takes part in eligibility.** `IL/no-match` never does: it records what the
detection stage concluded and decides nothing about whether a message may be processed.

**Never infer `IL/processed` from `IL/no-match`.** After a commit that *completed*, a no-match
message carries both — `IL/no-match` from the middle of the write and `IL/processed` from the end of
it — and it is the second one that keeps the message out of a later run. But the write order is
semantic labels, then `IL/no-match` where it applies, then `IL/processed`, and where the mail system
gives no atomicity that order can stop halfway: a message can carry `IL/no-match` with `IL/processed`
absent, which is [State B](#b-the-mailbox-commit-did-not-clearly-succeed). Such a message is
**still eligible** on a later run if it is still in the inbox, still unread and still without
`IL/processed` — the re-check asks about `IL/processed`, and about nothing else.

`IL/no-match` is about the **detection stage only**. It does not mean "no Inbox Labeler label
matched". A message can legitimately carry `IL/no-match` **and** a derived label, in exactly one
case: a derived label with no `required_labels` triggering on a message no detection label matched.
That is rare and it is correct — detection found nothing, interpretation found something.

`IL/processed` records that the work happened; `IL/no-match` records what detection concluded. They
are independent.

**Inbox Labeler owns the `IL/` namespace and nothing outside it.** Read the user's own mailbox
labels freely when they help a decision; never add or remove one.

### Bound each run

**A run processes at most ten messages and then stops. Ten is a hard maximum, not a default.**
Fewer is fine: if only three are eligible, handle three; if none are, handle none.

**Nothing raises it.** "Process fifty", "process my entire inbox", "process all my unread mail",
"ignore the limit" — each of those is answered with a run of at most ten and a plain statement that
more remain. There is no flag, no phrasing and no user request that produces an eleventh message in
one run, and there is no override to offer as a workaround. Someone who wants more runs it again.

This is a blast-radius limit rather than a preference: ten messages is how much a run can get wrong
before a person sees it, and labelling only ever moves forward, so mail labelled in error stays
labelled.

The limit changes *how many* messages a run touches, never *which* ones or how they are judged.
Eligibility is [step 3](#3-select-the-messages-to-process) and is untouched by it; the run simply
ends early. A message skipped by the per-message re-check was never eligible, so it does not count
against the ten.

Everything beyond the limit is left alone. It never received `IL/processed`, so it is still in scope
for the next run and there is no cursor to keep.

**Always say how many you handled and whether more eligible messages remain**, so the user knows
another run is worth it. Within a run, size is never a reason to pause: do not sample, do not ask
for confirmation because the inbox is large, and do not cut a message short because it matched many
labels.

### Reporting

Say how many messages were handled, which got which labels and why, which matched nothing, which
labels came from interpretation, and where a derived label's gate matched but the interpretation
still said no. Name any message that went unrecorded and why. Report anything you were unsure about
rather than guessing silently. If the run stopped at its bound, say so.

## Apply attention

**Only when the user asks.** Never part of processing.

This acts on mail that has **already** been classified and brings mailbox state in line with the
attention the labels already imply. It classifies nothing, reads no message content, and adds or
removes no `IL/` label.

**Its scope is the mirror image of normal processing**, and the two never overlap:

| Workflow | Scope |
| --- | --- |
| **normal processing** ([step 3](#3-select-the-messages-to-process)) | inbox **and** unread **and** **not** `IL/processed` |
| **apply attention** | inbox **and** unread **and** `IL/processed` |

Both are scoped to unread inbox mail; they differ only in the marker. Read mail is out of scope for
both.

1. **Call `get_labels`** for the current policy. Attention is read from it, never from the mailbox.
2. Select messages that are in the inbox, unread, and **do** carry `IL/processed`. Re-check those
   three on each message before acting on it, for the same reason
   [step 3](#3-select-the-messages-to-process) does.
3. **Read the labels already on the message.** Take its mailbox labels and keep the `IL/` ones,
   stripping the prefix. Do not look at the message body and do not reconsider whether a label
   belongs there.
4. **Keep only the ones the current policy still has.** Match each stripped name against the policy
   using Inbox Labeler's own rules — whitespace normalised, compared case-insensitively; see
   [Labels are identified by their text](#labels-are-identified-by-their-text).
   - `IL/processed` and `IL/no-match` are state, not meaning, and never take part.
   - An `IL/` label that matches **no** policy label is **obsolete or unknown**. It is left out of
     the calculation entirely. **Never guess its attention from its name**, from what it used to be,
     or from anything else — a label that is not in the policy has no attention.
   - **Collect these and report them separately**, so the user learns that stale mailbox labels
     exist. Do not delete them; that is the user's call.
   - If nothing is left after this filter, the message has no matched labels and comes out `normal`.
5. Compute the effective attention over the remaining labels, with the ranking in
   [step 6](#6-determine-attention).
6. Carry out the policy for that level:

   | Attention | Action |
   | --- | --- |
   | `high` | star the message, and keep it starred |
   | `none` | mark it read once it is **at least 24 hours old**; otherwise do nothing |
   | `normal` | no action |

   Age counts from when the message was received, and the threshold is inclusive — exactly 24 hours
   qualifies. Skip an action whose state already holds; do not re-star a starred message. **If the
   connected mail system cannot perform one of these actions, report that limitation** and leave the
   message alone; never substitute a different action.
7. Report what changed per message, what was left alone, and which obsolete `IL/` labels you found.

**Starring and marking read are the only two things this workflow writes.** It never touches an
`IL/` label in either direction — no adding, no removing, no creating and no recolouring — and
never the message content.

Marking read belongs here and nowhere else. **Processing never changes the unread state** — unread
is a scope filter, not a processing state.

## Editing the label policy

A separate workflow. **Only when the user explicitly asks** to create, change, rename or delete a
label. Processing never does this.

Read the policy with `get_labels` first — the existing detection labels are the vocabulary. Reuse
them rather than creating a near-duplicate: if `Large amount` is there, do not add `Big amount`.

### Working out the shape

The user describes what they want; deciding *how* to model it is your job. Never ask them to choose
between detection and derived.

Start from meaning: **what would have to be true of a message for this label to belong on it?**

- Recognisable **directly in the message** → a **detection** label.
- An **interpretation of things already recognised** → a **derived** label.

Then ask how many concepts the request contains, and put each through the reuse question:

> Would this concept be worth detecting on its own, on mail that has nothing to do with the rest of
> this request?

- **Yes, for more than one** → model each as its own detection label, and add a derived label on
  top when the combination carries meaning the parts do not.
- **No** → it is one aspect described in several words. One detection label, and let the
  instruction carry the detail.

**Several concepts mentioned is not a reason to split — several concepts reusable apart is.**

Create supporting detection labels **before** the derived label that references them: the
references must already exist, and a label's type cannot be changed afterwards.

Put every derived label through the rejection question:

> Is there a message where every required label matches and this label still does not belong?

If the answer is no, the label is not interpreting anything — its instruction restates the
conjunction. Say whether what it really adds is a threshold or an attention level.

### Rules

- `create_label` requires `label` and `instruction`; `type` defaults to detection and `attention`
  to normal.
- Creating a label whose text collides with an existing one, ignoring case, is refused.
- `update_label` with `new_label` renames, and rewrites every reference in the same write.
- `delete_label` removes the label **and its whole match history**, and is refused while another
  label still references it.
- Reference lists may only name detection labels.
- **Editing the policy never changes mail that was already classified.** If the user expects a
  change to reach earlier mail, say plainly that it will not: labelling only moves forward.

## Reading history

`get_matches` returns, per label, a count per calendar day and the timestamp of the newest message
it matched. **The daily buckets are UTC calendar days**, taken from each message's own timestamp, so
a message counts towards the UTC day it was sent — not the day it was processed and not the reader's
local day. Use it to answer questions about which labels actually fire and how often.

**It must never influence classification.** Do not consult it to decide whether a label applies,
and do not let a label's history change how a message is judged.

## Safety and consistency rules

- **`get_labels` is the source of truth.** Never a local file, never a remembered policy, never an
  earlier run's output.
- **No policy, no processing.** An empty result stops the run.
- **Detection before derived, always.**
- **The instruction decides, not the name.**
- **Attention comes from the matched labels' policy**, by the fixed ranking. Never a scheme of your
  own.
- **`record_matches` uses the email's own timestamp**, with a UTC offset.
- **Create mailbox labels only inside `IL/`.** The user's own labels are read-only.
- **Never mutate the policy unless the user asked to change it.**
- **Labelling only ever adds.** Never remove a mailbox label, never archive, never delete, never
  reply.
- **Normal processing is inbox and unread and not `IL/processed`** — all three, re-checked per
  message. [Step 3](#3-select-the-messages-to-process) is authoritative; a read message, an archived
  one, and one already carrying the marker are each out of scope.
- **Never change the unread state during processing.** Unread is a scope filter, not a processing
  state, and marking read belongs to [apply attention](#apply-attention) alone.
- **Ten messages per run is a hard maximum**, not a default, and no request raises it. See
  [Bound each run](#bound-each-run).
- **If mail tools are unavailable, do not fake it.** What each missing capability means is in
  [Preconditions](#preconditions).

The order of operations for one message lives in
[step 8](#8-commit-the-mailbox-state-then-record-what-matched), and what any failure means lives in
[Failure, retry and consistency](#failure-retry-and-consistency). Those two sections are
authoritative; this list adds nothing to them and must not be read as a second version of them.

## Examples

### Two detection labels and a derived label

An invoice for a large amount, where the policy holds `Invoice` and `Large amount` as detection
labels and a derived label gated on both:

```text
Detection:  Invoice        — states "invoice INV-4021" with an amount due
            Large amount   — 1,450.00 EUR, over the threshold
Derived:    the gate matched and the interpretation agreed
Attention:  high, from the derived label
Commit:     IL/Invoice, IL/Large amount, IL/<the derived label>, IL/processed
            — one mailbox operation where the mail system offers one
Then:       record_matches(["Invoice", "Large amount", "<the derived label>"],
                           "2026-08-20T10:12:00Z")
```

The sequence and the conditions are in
[step 8](#8-commit-the-mailbox-state-then-record-what-matched); this is only what it looks like on one
message.

### A gate that matched and an interpretation that said no

The same two detection labels, but the message is a receipt for a payment already made. The derived
label's gate matched; its instruction did not. **Report the rejection** — it is the clearest sign
the interpretation is doing work — and record only the two detection labels.

### No detection label matched, and a derived label still applied

A derived label with no `required_labels` is evaluated for every message, so a message no detection
label matched can still receive it. The message carries `IL/no-match` **and** that derived label,
and the derived label is recorded. `IL/no-match` describes the detection stage, not the outcome as
a whole — it means *no detection label matched*, never *no Inbox Labeler label matched*.

### Attention where the quiet label wins

A message matching a label at `normal` and one at `none` comes out **none**, because `normal` is the
absence of a request and `none` is a request. Left alone during processing; marked read by **apply
attention** once it is at least 24 hours old.
