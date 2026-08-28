---
name: inbox-labeler-mcp
description: Classify inbox messages against the label policy held by the hosted Inbox Labeler MCP, decide how much attention each message deserves, and record what matched. Use when the user asks Inbox Labeler to process or label their inbox, to apply attention, or to create, change, list or delete labels. This is the hosted version: the MCP holds the policy and the history, and no local files are involved.
---

# Inbox Labeler

## Purpose

Inbox Labeler holds a **label policy** — user-defined labels, each naming an aspect of a message
worth noticing — and applies it to the user's mail on request. Four workflows, kept apart:

| Workflow | What it does | When it runs |
| --- | --- | --- |
| **Process labels** | classify unread inbox messages that are not already processed, against the policy | the user asks to process or label the inbox |
| **Apply attention** | act on what the policy implies for already-classified mail | only when the user asks |
| **Update matches** | record matched labels for successfully handled messages | inside processing — never asked for |
| **Edit the policy** | create, change, rename or delete a label | only when the user asks |

Processing never changes the policy, changing the policy never touches mail, and nothing is
scheduled: every run happens because the user asked for it.

## Preconditions

**The MCP is not enough on its own.** It holds the label policy and the match history and nothing
else, and it has **no access to the user's email account**. So two connections are needed: the
**mail system** provides the messages and the mailbox actions taken on them, the **MCP** provides
the policy and the history. For Gmail that means Gmail connected with the permissions below; another
mail system works too, as long as it can do the same things.

### What the mail connection has to be able to do

**To process an inbox at all:**

- read inbox messages
- tell whether a message is **in the inbox** and whether it is **currently unread** — both are part
  of what makes a message eligible; see [step 3](#3-select-the-messages-to-process)
- inspect the mailbox labels already on a message, and the mailbox labels that exist
- create Inbox Labeler's mailbox labels in the `IL/` namespace, and apply them to messages

**Strongly preferred:** applying several labels in **one** operation — fewer writes, fewer ways to
end up half applied, though not by itself all-or-nothing; see
[step 8](#8-commit-the-mailbox-state-then-record-what-matched).

**To apply attention, additionally:** star a message, and mark a message as read. **Optional:**
setting a label's colour, which never blocks anything.

### When a connection is missing or limited

- **The Inbox Labeler MCP is unreachable** → stop and say so. **Never classify from a remembered,
  cached or stale policy.**
- **Mail cannot be read** → inbox processing cannot run.
- **`IL/` labels cannot be created or applied at all** → classification may be presented as a plan,
  but nothing is processed and no history recorded. [Step 2](#2-prepare-the-mailbox) decides this;
  [Failure, retry and consistency](#failure-retry-and-consistency) says what follows. A *single*
  failing label is the narrower case, handled in those same two places.
- **Starring or marking read is unavailable** → processing is unaffected. Only the corresponding
  [apply attention](#apply-attention) actions cannot run, and that has to be reported rather than
  worked around.

**Identity is the authenticated MCP session.** Never ask the user for an account id and never pass
one to any tool.

### Two sets of tools share names

`get_labels`, `create_label`, `update_label`, `delete_label`, `get_matches` and `record_matches`
**always mean Inbox Labeler's MCP tools and always act on the policy**. A mail connector usually
exposes similarly named tools for **mailbox** labels; confusing them writes to the wrong place.
Anything to do with the mailbox is described here in prose — "apply the mailbox label".

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

**An empty policy means stop.** It does not mean "nothing matched": say that none are configured and
offer to create some. Never invent a starter set, and never carry a policy between runs.

### 2. Prepare the mailbox

Once per run, after `get_labels` and before any message is touched.

**Establish that the processed marker works:** `IL/processed` must be readable, must exist or be
creatable, and must be applicable to a message. **If any of the three cannot be established, this
run processes nothing** — classification may still be offered **as a plan**, but apply no semantic
mailbox labels, call no `record_matches`, and describe no message as processed. Say which failed.

**Bring the mailbox labels in line with the policy.** Walk the **complete** set `get_labels`
returned and, where supported, ensure each `IL/<label>` exists and its colour matches that label's
`attention` — the **only** place colours are written, and where a changed attention level catches
up ([Colour follows attention](#colour-follows-attention)). Ensure `IL/no-match` exists too; it and
`IL/processed` are state, not labels, and get no colour.

**A label that could not be created here does not stop the run.** Report it and carry on with
messages that do not need it; if a later message does, repeat that one label's preparation at the
point of use. If that fails too, the message is
[A. Failure before the mailbox commit](#a-failure-before-the-mailbox-commit).

**Create nothing outside `IL/`**, and never rename, recolour or otherwise modify a mailbox label of
the user's own.

### 3. Select the messages to process

**During normal processing, consider only messages that are currently in the inbox, are currently
unread, and do not carry `IL/processed`.** This is the authoritative eligibility rule; everywhere
else in this document refers here. All three conditions are required, and **a message failing any
one of them is skipped** — not classified, given no semantic `IL/` label, no `IL/no-match` and no
`IL/processed`, and never recorded.

**Unread and `IL/processed` are different things and neither substitutes for the other.** Unread is
a **scope filter**; `IL/processed` is a **processing state**:

- A **read** message with no `IL/processed` is **out of scope**, deliberately. Inbox Labeler labels
  mail the user still has to deal with. Normal processing never reaches back for it.
- An **unread** message carrying `IL/processed` is **out of scope for normal processing** — the work
  is finished. That message is what [apply attention](#apply-attention) works on.
- A message that is not in the inbox — filed or archived — is out of scope either way.

**Processing never changes a message's read state.** Marking read belongs to apply attention alone.

#### Narrow the search where the mail system can

Ask the mail system for candidates that are already in the inbox, unread and without `IL/processed`,
using whatever its search supports. **Narrowing the search is an optimisation, never the
guarantee** — the per-message re-check below enforces eligibility, including where a search cannot
express one of the three conditions at all.

Gmail, as **one example**:

```text
in:inbox is:unread -label:<the IL/processed mailbox label>
```

Some connectors want that label's **id** rather than its display name; use whichever the connected
one accepts. **This is an illustration, not the interface.**

The user may narrow selection further — "everything from today" — and that is selection, not
meaning: it changes which messages are considered, never how any of them is judged.

#### Re-check every message individually

**A search result is a suggestion; the message itself is the authority.** Mail systems return
thread-shaped results, so one match can bring along messages that do not qualify, and a message's
state can change between the search and the moment it is reached.

**Immediately before processing each individual message, re-check all three conditions on that
message:**

1. Is it **in the inbox**?
2. Is it **currently unread**?
3. Does it **lack `IL/processed`**?

**Only if all three are true may that message be processed.** If any one is false, skip it: do not
classify it, do not apply a semantic `IL/` label, do not apply `IL/no-match`, do not apply
`IL/processed`, and do not call `record_matches`. A skipped message does not count against the
run's limit — see [Bound each run](#bound-each-run).

Steps 4 to 8 then run for each message that qualified, one message at a time.

### 4. Evaluate detection labels

Work through **every** detection label and decide each one **independently**. Whether a label
applies depends on exactly two things: the message, and that label's own `instruction`.

- **The instruction is authoritative.** Never classify from a label's name. `Login` means whatever
  its instruction says it means.
- Subject, sender and a snippet are usually enough; read the full body when they are not.
- The result is the complete set that applied — none, one, several, or all.
- **Note one short reason per match.** That is the **evidence**, which the derived stage and the
  summary both need.

### 5. Evaluate derived labels

Only after the detection stage has finished for that message. A derived label does not rediscover
the message: it reads the message **together with the detection labels that matched**.

- **Skip a derived label whose `required_labels` did not all match.** Not a failure; it does not
  apply to this message.
- **`recommended_labels` never gate anything.** Include the ones that matched as context; when none
  did, evaluate the label anyway.
- A derived label with **no** `required_labels` is evaluated for every message.
- Derived labels never reference other derived labels, and one derived label's outcome is never
  input to another.
- **A derived label may say no.** The required labels decide which messages are considered; the
  instruction decides which of those the label belongs on. Report a rejection — that is the
  interpretation doing its job.

One derived label per evaluation, given exactly four things and nothing else:

```text
Email          from, subject, and enough body to judge
Detection      only the labels that matched, each with its one-line evidence
               (if none matched, say so rather than listing anything)
Label          the derived label and its instruction
Task           does it apply? yes or no, briefly explained
```

Treat the detection labels as established facts — do not re-check them.

### 6. Determine attention

Attention is **not a label**. It is what a label asks of the user, declared per label and computed
per message, and it is never stored on a message: `none` means the user never needs to see this,
`normal` (the default) means leave it alone, `high` means important and stays important.

**The highest-priority level among the labels a message carries wins, ranked
`high` > `none` > `normal`:**

1. any matched label at `high` → **high**
2. otherwise, any matched label at `none` → **none**
3. otherwise → **normal**

`normal` loses to both because it is the *absence* of a request: a message carrying `Invoice`
(`normal`) and `Newsletter` (`none`) comes out **none**. A message with no matched labels comes out
`normal` and is left alone.

**Do not invent a different priority scheme**, do not weight by how many labels matched, and do not
let your own reading override it.

### 7. Present or act on the result

Attention decides prioritisation and presentation; it **never** causes a label to be invented. When
presenting mail, order by attention — `high`, then `normal`, then `none` — and say which labels
produced each level. During processing, reporting the level is enough: changing mailbox state is the
separate [apply attention](#apply-attention) workflow.

### 8. Commit the mailbox state, then record what matched

**This is the authoritative per-message sequence.** Nothing else restates it.

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
whose matches were counted can never look unprocessed to a later run.

**Step 4 — the complete set**, worked out before anything is written: every semantic label that
matched as `IL/<label>`, detection and derived alike; `IL/no-match` when no detection label matched;
and `IL/processed`, always. Policy texts carry no prefix, so `Large amount` becomes
`IL/Large amount`. Every label must exist before the commit — from
[step 2](#2-prepare-the-mailbox), or by repeating its preparation at the point of use.

**Step 5 — the mailbox commit**, before anything is recorded. Prefer one operation where the mail
system applies several labels at once — `apply ["IL/Invoice", "IL/Large amount", "IL/processed"]`.
**Accepting several labels in one call is not a guarantee that they are applied together:** treat it
as atomic **only where the mail system explicitly guarantees atomicity**. Otherwise a call can leave
a message partly labelled, or succeed while its response is lost.

**Without a multi-label operation, write them separately, in this order:**

```text
1  every required semantic label  IL/<label>
2  IL/no-match, when applicable
3  IL/processed  — last within the mailbox phase
```

`IL/processed` goes on **after** the labels it vouches for. Written earlier it would produce a
message that looks processed while it is not — and normal processing skips such a message rather
than fixing it.

**A write that failed or whose outcome is unclear is decided by re-reading the mailbox, not by its
return value** — see
[B. The mailbox commit did not clearly succeed](#b-the-mailbox-commit-did-not-clearly-succeed).

**Step 6 is one `record_matches` call**, made only after the commit succeeded, naming every
semantic label that matched with that message's own timestamp:

```text
record_matches(labels: ["Invoice", "Large amount", "Large payment needs attention"],
               email_timestamp: "2026-08-20T10:12:00Z")
```

- **The timestamp is the email's own, never the moment you are running** — a message written in
  March counts towards March — and needs a UTC offset, or it is refused rather than guessed.
- **Never name the same label twice in one call.** The whole call is refused.
- **No semantic matches, no call.** Such a message still got its markers in the commit, and markers
  are never recorded as matches.
- **Pass label names and the timestamp, and nothing else.** Not the subject, sender, recipients,
  body, message or thread id, or anything about an attachment. Inbox Labeler keeps counts, not mail.

When a step does not succeed, see
[Failure, retry and consistency](#failure-retry-and-consistency).

### Colour follows attention

A semantic label's mailbox colour is fixed presentation derived from that label's `attention`. The
MCP does not store it; it is never a second source of truth.

| `attention` | `backgroundColor` | `textColor` |
| --- | --- | --- |
| `none` | `#cccccc` | `#000000` |
| `normal` | `#fce8b3` | `#000000` |
| `high` | `#efa093` | `#000000` |

- **Colours are written in [step 2](#2-prepare-the-mailbox) and nowhere else** — on creation, and on
  a label whose attention changed since.
- **Compare before writing**, which keeps repeated runs idempotent.
- **The state markers get no colour**, and never pick a colour by hand. These three rows are the
  whole mapping.
- **Colour never blocks anything.** Without colour support, carry on; where one cannot be set, name
  the label and continue.

## Failure, retry and consistency

**This is the authoritative failure section.** Every other part of this document refers here.

What is protected, in this order: **correct mailbox state**, then **no duplicate processing or
duplicate counts**, then **complete match history**. Losing a history update in an exceptional
failure is acceptable; making a processed message eligible for reprocessing to repair its history is
not. History is additive and Inbox Labeler stores **no message id and no idempotency key**, so
nothing server-side can tell a message was recorded before: **`IL/processed` is the whole of the
protection.** Two hard rules follow:

- **Never process or record a message that already carries `IL/processed`.** It is finished; leave
  it alone, including when its history might be incomplete.
- **Within one processing attempt, call `record_matches` at most once for that message.**

### A. Failure before the mailbox commit

Classification could not complete, or a required semantic label could not be prepared or created.

- Do **not** establish `IL/processed`, and do **not** call `record_matches`.
- Report the message as incomplete and say what failed.

The message is untouched as far as processing is concerned and stays eligible for the next run. A
colour that could not be set is **not** this case — name the label and carry on.

### B. The mailbox commit did not clearly succeed

A mailbox write failed, or its outcome is unclear because the response was lost or the call timed
out.

**A failed or unclear write says nothing reliable about the mailbox.** Unless the mail system
guarantees atomicity and reported a clean failure, **re-read the message's current `IL/` mailbox
labels** and decide from what is actually there. Never assume the write left no trace, and never
assume `IL/processed` is absent just because the call did not report success.

**State A — the complete required set is present, `IL/processed` included.** The commit succeeded,
whatever the response said. Treat it as
[C. The mailbox commit succeeded](#c-the-mailbox-commit-succeeded) and proceed to `record_matches`
if any semantic label matched. Do **not** repeat the mailbox writes.

**State B — `IL/processed` is absent.** The commit is incomplete.

- Do **not** call `record_matches`.
- Report the partial mailbox state, naming which labels are present. **Do not claim anything was
  rolled back** — semantic labels already applied stay applied.
- The message remains eligible for a later normal processing attempt, which re-applies what is
  already there — harmless — and completes the commit.

**State C — `IL/processed` is present, but a required semantic label or `IL/no-match` is missing.**
**This is an inconsistent processed state, and it is the one failure that does not heal.**

- Do **not** call `record_matches`.
- **Report it prominently**, naming the message and exactly which labels are missing, and do **not**
  describe the message as safely processed.
- **Do not say a normal run will repair it.** It will not: normal processing skips anything carrying
  `IL/processed`, which is precisely why this state persists.
- Do **not** silently remove `IL/processed`, and do not invent a repair procedure.

Leave the decision — complete the labels by hand, or remove `IL/processed` so a normal run can redo
the message — to the user.

### C. The mailbox commit succeeded

Once the complete set is established, `IL/processed` included, **the message is processed** from the
mailbox's point of view. That is the state that counts.

Only now may match history be updated.

### D. `record_matches` definitely failed

The commit succeeded and the call was refused, with the refusal seen — a repeated label name, a
timestamp without an offset, a label the policy does not have.

- **The message stays processed.** Do **not** remove `IL/processed` or any semantic label.
- Report that **mailbox processing succeeded and match-history recording failed**, with the reason.
- **A normal processing run must not pick this message up again to repair its history.**

### E. `record_matches` outcome is uncertain

The commit succeeded and the response was lost or the call timed out, so the server may or may not
have recorded.

- **The message stays processed.**
- **Report the match-history state as uncertain** — never as definitely failed, never as definitely
  recorded.
- Do **not** retry the call automatically.
- Do **not** remove `IL/processed`, and do **not** make the message eligible for normal processing
  again.

Avoiding duplicate history matters more than completing it.

### Missing marker capability

If [step 2](#2-prepare-the-mailbox) did not establish that `IL/processed` can be read, created and
applied, this run does not process anything — classification may be presented as a plan. Asking the
user "has this been processed before?" is **not** a substitute for the marker.

### Scope of a failure

**One failing message is not a failing run.** Report it and carry on with the rest.

## Label semantics

### Labels are identified by their text

A label's text is its **only** identifier — no separate name, no id. References name it exactly,
spaces included.

Inbox Labeler normalises before comparing or storing: **leading and trailing whitespace trimmed,
internal runs of whitespace collapsed to a single space**, then uniqueness decided **ignoring
case**. So `Delivery` and `delivery` are the same label, and `"  Large   amount "` is the same label
as `Large amount`. Use these same rules when comparing a mailbox label's text against the policy.

Write labels as ordinary phrases — `Delivery arriving soon`, not `DeliveryArrivingSoon` —
capitalising the first word only, unless a word is a proper noun or acronym.

### Labels are timeless

> **Evaluate every label as if you were reading the email at the moment it was written.**

The current date never influences whether a label applies, and neither does how long ago the message
arrived. A relative date inside the message — "tomorrow", "next Tuesday" — is a fact *about the
message*, read against the message's own date. The same message evaluated twice yields the same
labels; if an outcome differs, the policy changed, never the clock. So an email from last week
saying "your package arrives tomorrow" can still correctly receive a label about imminence.

**"Is this still relevant?" is a different question.** Labels like `Expired` or `Needs attention
today` compare a message against the clock and cannot be labels at all. Say so plainly and offer the
timeless part instead: "payment due soon" can be read off a message; whether that date has passed
cannot.

Time has one legitimate role, upstream of evaluation: **choosing which messages to look at.**

### Detection and derived labels

- **Detection** — *what can I directly observe in this message?* They recognise facts, and they are
  the default.
- **Derived** — *given the message and the detection labels that matched, what does this mean?* They
  interpret facts detection already established.

`required_labels` is an **AND gate**: every one must have matched, or the derived label is not
evaluated at all for that message. `recommended_labels` is **context, not a gate**: any subset may
be present, and their absence never blocks anything.

Both lists hold plain label texts, both may be empty, and both may **only** name detection labels.
There is no chaining from one derived label to another.

## Batch and inbox processing

### One message at a time

The unit of work is a **message**, never a thread. A search may return a whole thread when one of
its messages matches, so **re-check each message's own eligibility before processing it**, exactly as
[step 3](#3-select-the-messages-to-process) requires. Classify a message completely — steps 4 to 8 —
before moving to the next.

### Scope and the two markers

Eligibility is [step 3](#3-select-the-messages-to-process) — **in the inbox, unread, and without
`IL/processed`**. This section is what the two markers mean.

| Marker | Meaning |
| --- | --- |
| `IL/processed` | Inbox Labeler has finished evaluating this message |
| `IL/no-match` | **no detection label matched** this message |

**Only `IL/processed` takes part in eligibility.** `IL/no-match` never does: it records what the
detection stage concluded and decides nothing about whether a message may be processed.

**Never infer `IL/processed` from `IL/no-match`.** After a completed commit a no-match message
carries both, and it is `IL/processed` that keeps it out of a later run. But the write order puts the
marker last, so without atomicity a message can carry `IL/no-match` with `IL/processed` absent —
[State B](#b-the-mailbox-commit-did-not-clearly-succeed). Such a message is **still eligible** on a
later run if it is still in the inbox, still unread and still without `IL/processed`: the re-check
asks about `IL/processed`, and about nothing else.

`IL/no-match` is about the **detection stage only**, not "no Inbox Labeler label matched": a message
can legitimately carry `IL/no-match` **and** a derived label, when a derived label with no
`required_labels` triggers on a message no detection label matched.

**Inbox Labeler owns the `IL/` namespace and nothing outside it.** Read the user's own mailbox
labels freely when they help a decision; never add or remove one.

### Bound each run

**A run processes at most ten messages and then stops. Ten is a hard maximum, not a default.**
Fewer is fine: if only three are eligible, handle three; if none are, handle none.

**Nothing raises it.** "Process fifty", "process my entire inbox", "process all my unread mail",
"ignore the limit" — each is answered with a run of at most ten and a plain statement that more
remain. There is no flag, no phrasing and no user request that produces an eleventh message in one
run, and there is no override to offer as a workaround. Someone who wants more runs it again. This
is a blast-radius limit: labelling only moves forward, so mail labelled in error stays labelled.

The limit changes *how many* messages a run touches, never *which* ones or how they are judged.
Eligibility is [step 3](#3-select-the-messages-to-process) and is untouched by it. A message skipped
by the per-message re-check was never eligible, so it does not count against the ten. Everything
beyond the limit never received `IL/processed`, so it is still in scope for the next run and there
is no cursor to keep.

**Always say how many you handled and whether more eligible messages remain.** Within a run, size is
never a reason to pause: do not sample, do not ask for confirmation because the inbox is large, and
do not cut a message short because it matched many labels.

### Reporting

Say how many messages were handled, which got which labels and why, which matched nothing, which
labels came from interpretation, and where a derived label's gate matched but the interpretation
still said no. Name any message that went unrecorded and why, and report anything you were unsure
about rather than guessing silently. If the run stopped at its bound, say so.

## Apply attention

**Only when the user asks.** Never part of processing.

It brings mailbox state in line with the attention the labels of **already-classified** mail imply.
It classifies nothing, reads no message content, and adds or removes no `IL/` label.

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
3. **Read the labels already on the message**, keeping the `IL/` ones and stripping the prefix. Do
   not look at the body and do not reconsider whether a label belongs there.
4. **Keep only the ones the current policy still has**, matched by [Inbox Labeler's own
   rules](#labels-are-identified-by-their-text). `IL/processed` and `IL/no-match` are state, not
   meaning, and never take part. An `IL/` label matching **no** policy label is obsolete or unknown:
   leave it out entirely and **never guess its attention**. **Collect these and report them
   separately**; deleting them is the user's call. If nothing is left, the message comes out
   `normal`.
5. Compute the effective attention over the rest, ranked as in [step 6](#6-determine-attention).
6. Carry out the policy for that level:

   | Attention | Action |
   | --- | --- |
   | `high` | star the message, and keep it starred |
   | `none` | mark it read once it is **at least 24 hours old**; otherwise do nothing |
   | `normal` | no action |

   Age counts from when the message was received, and the threshold is inclusive. Skip an action
   whose state already holds. **If the mail system cannot perform one, report that limitation** and
   leave the message alone; never substitute another.
7. Report what changed per message, what was left alone, and which obsolete `IL/` labels you found.

**Starring and marking read are the only two things this workflow writes.** It never touches an
`IL/` label in either direction, and never the message content. Marking read belongs here and
nowhere else: **processing never changes the unread state** — unread is a scope filter, not a
processing state.

## Editing the label policy

A separate workflow. **Only when the user explicitly asks** to create, change, rename or delete a
label. Processing never does this.

Read the policy with `get_labels` first — the existing detection labels are the vocabulary. Reuse
them rather than creating a near-duplicate: if `Large amount` is there, do not add `Big amount`.

### Working out the shape

Deciding *how* to model what the user describes is your job; never ask them to choose between
detection and derived. **What would have to be true of a message for this label to belong on it?**
Observable **directly in the message** → **detection**. An **interpretation of things already
recognised** → **derived**.

Put each concept in the request through the reuse question — *would this be worth detecting on its
own, on mail unrelated to the rest of this request?* **Yes, for more than one** → each becomes its
own detection label, with a derived label on top when the combination carries meaning the parts do
not. **No** → one detection label, with the instruction carrying the detail. *Several concepts
mentioned is not a reason to split — several concepts reusable apart is.*

Create supporting detection labels **before** the derived label that references them: references
must already exist, and a label's type cannot be changed afterwards.

Put every derived label through the rejection question — *is there a message where every required
label matches and this label still does not belong?* If not, the label is not interpreting anything;
say whether what it really adds is a threshold or an attention level.

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
a message counts towards the UTC day it was sent — not the day it was processed, and not the
reader's local day.

**It must never influence classification.** Do not consult it to decide whether a label applies, and
do not let a label's history change how a message is judged.

## Safety and consistency rules

A checklist, not a second authority. Each rule's full statement is where it is linked.

- **`get_labels` is the source of truth**, on every run. An empty policy stops the run.
- **Detection before derived, always**, and **the instruction decides, not the name.**
- **Attention comes from the matched labels' policy**, by the fixed ranking.
- **Normal processing is inbox and unread and not `IL/processed`** — all three, re-checked per
  message. [Step 3](#3-select-the-messages-to-process) is authoritative; a read message, an archived
  one, and one already carrying the marker are each out of scope.
- **Never change the unread state during processing.** Unread is a scope filter, not a processing
  state, and marking read belongs to [apply attention](#apply-attention) alone.
- **Ten messages per run is a hard maximum**, not a default, and no request raises it. See
  [Bound each run](#bound-each-run).
- **Labelling only ever adds**, and only inside `IL/`. Never remove a mailbox label, never archive,
  never delete, never reply; the user's own labels are read-only.
- **`record_matches` uses the email's own timestamp**, with a UTC offset, and carries nothing about
  the message itself.
- **Never mutate the policy unless the user asked to change it.**
- **If mail tools are unavailable, do not fake it.** See [Preconditions](#preconditions).

The per-message order lives in
[step 8](#8-commit-the-mailbox-state-then-record-what-matched); what any failure means lives in
[Failure, retry and consistency](#failure-retry-and-consistency).
