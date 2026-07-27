---
name: inbox-labeler
description: Manage persistent labels (name + logical label + instruction) and apply them to inbox emails as Gmail labels on demand. Use when the user wants to create, change, delete, list or inspect labels, or asks Inbox Labeler to process or reprocess / relabel their inbox.
---

# Inbox Labeler

Inbox Labeler manages **labels**. Each one names the aspect of a message it detects and the
Gmail label to apply when that aspect is present:

| Field | Meaning |
| --- | --- |
| `id` | stable identifier, generated on create — the only handle for get, update and delete |
| `name` | short human name for the aspect, e.g. `Invoice` |
| `label` | **logical** label, stored without a prefix, e.g. `Invoice` — resolves to the Gmail label `IL/Invoice` |
| `type` | how the label decides whether it applies: `detection` or `derived` |
| `instruction` | how you decide whether that aspect is present in a message, in natural language |
| `required_labels` | *derived only* — detection labels that must all have matched before this label is evaluated |
| `recommended_labels` | *derived only* — detection labels offered as context when they matched |

`label` holds the logical label only. `IL/` is Inbox Labeler's Gmail namespace — plumbing,
not part of a label's identity — so it never appears in stored configuration and is added
only when talking to Gmail: **the logical label `Invoice` resolves to the Gmail label
`IL/Invoice`.** Resolve in that direction every time you create a Gmail label, apply one,
remove one, compare one against a message's labels, or name one in output.

## Label types

`type` is the label's kind. There are two, and both produce a Gmail label the same way — the
only difference is how they decide.

| Type | Question it answers |
| --- | --- |
| `detection` | *What can I directly observe in this email?* |
| `derived` | *Given the email and the detection labels that matched, what does this mean?* |

**Detection labels recognise facts. Derived labels interpret those facts.**

A detection label reads the email and decides. `Invoice`, `Newsletter`, `Login`,
`LargeAmount` are detection labels.

A derived label does **not** rediscover the email from scratch. It reads the email *together
with the detection labels that already matched* and decides what that combination means:

```text
Email
  ↓
Detection labels:  Invoice, LargeAmount
  ↓
Derived label:     LargePaymentNeedsAttention
```

```text
Email
  ↓
Detection labels:  TravelBooking, FlightCancellation
  ↓
Derived label:     TravelDisruption
```

The email is still available when a derived label is evaluated. The detection labels are
structured context that makes the decision easier and more consistent — use them as given
facts rather than re-deriving them.

A derived label names the detection labels it builds on:

- **`required_labels`** — every one of them must have matched, or the derived label is not
  evaluated at all for that message. This is the gate.
- **`recommended_labels`** — helpful context. Include them in the prompt when they matched;
  when they did not, evaluate the derived label anyway.

Both hold **logical labels** (`LargeAmount`, not `IL/LargeAmount`), both may be empty, and both
may only point at detection labels. A derived label with no `required_labels` is evaluated for
every message. Derived labels never reference other derived labels — there is no chaining, and
the CLI rejects it.

The CLI rejects any type other than `detection` and `derived`. Do not invent a third.

## What a label is

> A user-defined way to detect an aspect of a message that is interesting to the user.

The aspect may be broad or narrow — that is entirely the user's choice, and both are equally
valid. A `Social` label covering everything from a social platform is a good one; so is
`Connection` for connection requests alone; so is a user keeping both. The set of labels the
user has defined *is* the model. Have no opinion about how fine-grained it should be.

What the design does fix is how labels behave together:

- **Independent.** Evaluate each label on its own. Whether it triggers depends on two things
  only: the message, and its own instruction.
- **Any number may trigger.** A message triggers as many labels as have their aspect present
  — none, one, several, or all of them.
- **Every trigger produces a Gmail label.** Each label whose aspect is present contributes
  its Gmail label to the message.
- **Additive, not alternatives.** For a given message the outcome is the complete set of
  triggered labels, and the Gmail labels applied are exactly that set.

Example: a LinkedIn connection request carries several aspects at once. It is social mail, it
is a connection request, and the user treats it as important. If the user keeps labels for all
three aspects, the message carries `IL/Social`, `IL/Connection` and `IL/Important` together.

## The `IL/` namespace

**Inbox Labeler owns the entire `IL/` namespace.** Every Gmail label whose name starts with
`IL/` is Inbox Labeler's to create, apply and remove — it is the whole of Inbox Labeler's
model, expressed as Gmail labels. The namespace is not a place for the user to keep labels of
their own: if they ask you to hand-create or hand-maintain one, explain that Inbox Labeler
manages that namespace and that the way to get a new `IL/` label is to add a label.

Every kind of Gmail label Inbox Labeler works with lives inside it:

| Kind | Origin | Logical label | Gmail label |
| --- | --- | --- | --- |
| **business labels** | the `label` of a detection or derived label | `Invoice`, `LargePaymentNeedsAttention` | `IL/Invoice`, `IL/LargePaymentNeedsAttention` |
| **bucket labels** | future label kind, not part of this version | — | — |
| **system labels** | Inbox Labeler's own state and outcome | `Processed`, `NoMatch` | `IL/Processed`, `IL/NoMatch` |

Both label types produce business labels; nothing in Gmail distinguishes a derived label's
output from a detection label's.

The two system labels:

| Gmail label | Meaning |
| --- | --- |
| `IL/Processed` | Inbox Labeler has finished evaluating this message. |
| `IL/NoMatch` | No **detection** label matched this message. |

`IL/Processed` records **processing state** — that the work happened. `IL/NoMatch` records
the **outcome** of detection — that no detection label matched. They serve different purposes
and are applied independently of one another.

`IL/NoMatch` is about detection only, and is decided before derived labels are evaluated. So a
message can carry `IL/NoMatch` together with a derived business label, in the one case where
that is possible: a derived label with no `required_labels` triggering on a message no detection
label matched. That is rare and it is correct — detection found nothing, interpretation found
something.

Because these two occupy `IL/Processed` and `IL/NoMatch`, the logical labels `Processed` and
`NoMatch` are reserved: the CLI rejects them on create and on update, case-insensitively. If a
user asks for one, explain that the name is taken by Inbox Labeler's own state and agree on a
different label.

**The boundary runs the other way too: Inbox Labeler never modifies a Gmail label outside
`IL/`.** Everything outside the namespace belongs to Gmail or to the user — `INBOX`, `UNREAD`,
`STARRED`, `IMPORTANT`, `CATEGORY_*`, and every label they made themselves. Read them freely
when they help a decision; never add or remove one.

## Storage

Labels are stored in `labels.json` in this skill's directory. The file is local, untracked,
and created automatically on first use — an empty list is a normal starting state, not an
error. Never edit it by hand: always go through the CLI below, which validates before writing.
(`labels.example.json` is documentation only — never read from or write to it.)

## Managing labels

Run these from this skill's directory:

```bash
# list every label
python3 labels.py list

# show one label
python3 labels.py get 8da8071c

# create a detection label — --type defaults to detection
python3 labels.py create \
  --name "Invoice" \
  --label "Invoice" \
  --instruction "The message is an invoice or bill for a purchase or service."

# create a derived label — repeat the reference flags for several labels
python3 labels.py create \
  --name "LargePaymentNeedsAttention" \
  --label "LargePaymentNeedsAttention" \
  --type derived \
  --instruction "A payment this large should be looked at before it is due." \
  --required-label "LargeAmount" \
  --recommended-label "Invoice"

# update a label — pass only the fields that change
python3 labels.py update 8da8071c --instruction "Invoices and receipts, but not payment reminders."

# delete a label
python3 labels.py delete 8da8071c
```

`get`, `update` and `delete` take the `id` only. When the user refers to a label by name, run
`list` first, match the name yourself, and use the `id` you found. If no name matches, or
several plausibly do, ask instead of guessing.

Every command prints JSON — including `type`, so the kind of label is always visible. On
failure it prints `{"error": "..."}` and exits non-zero.

### Modelling what the user asked for

The user describes a label they want. Working out *how* to model it is your job. Never ask
which type they want, never make them think about detection versus derived, and never default
to detection without looking at the concept first.

Start from meaning: **what would have to be true of an email for this label to belong on it?**

- If that can be recognised **directly in the email**, it is a **detection label** —
  `Invoice`, `Newsletter`, `Login`, `FlightCancellation`, `LargeAmount`.
- If it is an **interpretation of things already recognised**, it is a **derived label** —
  `LargePaymentNeedsAttention`, `TravelDisruption`, `CommercialOpportunity`.

Aim for the smallest useful model — as few labels as express the idea, and no fewer. Then:

1. **Run `list` first.** The detection labels that already exist are your vocabulary. Reuse
   them instead of creating a near-duplicate: if `LargeAmount` is there, do not add `BigAmount`.
2. **Name the observations the concept rests on.** When the user's label is an interpretation
   and the observations it needs do not exist yet, those become supporting detection labels.
3. **Create the supporting detection labels first**, then the derived label. Its references
   must already exist, and a label's type cannot be changed afterwards — so decide the shape
   before creating anything.

Choosing between the two reference lists follows from the user's wording:

- **`required_labels` is an AND gate** — every one of them must have matched. Use it for
  observations that all have to hold.
- **`recommended_labels` is context** — any subset may be present. Use it when one observation
  *or* another is enough to make the interpretation worth considering, and let the instruction
  weigh them.

If an interpretation seems to need another interpretation, the missing piece is a detection
label — derived labels never reference derived labels.

#### Example: an interpretation over new observations

> Create a label called TravelDisruption for emails where a cancellation or severe delay is
> likely to disrupt a trip.

"Likely to disrupt a trip" is a judgement, not something you read off the page. The observable
facts are the cancellation and the delay, and *either* one alone can disrupt a trip — so they
are recommended, not required:

```text
FlightCancellation      detection
FlightDelay             detection
TravelDisruption        derived   (recommended: FlightCancellation, FlightDelay)
```

#### Example: an interpretation over observations that must both hold

> Create a label called LargePaymentNeedsAttention for invoices with unusually large amounts
> that should be reviewed.

Being an invoice and carrying a large amount are two separate observations, and here the user
wants both:

```text
Invoice                     detection
LargeAmount                 detection
LargePaymentNeedsAttention  derived   (required: Invoice, LargeAmount)
```

Had they said "large payments, especially invoices", the amount would be the gate and the
invoice merely context: `required: LargeAmount`, `recommended: Invoice`.

#### Example: reuse instead of rebuilding

> Add CommercialOpportunity for mail that might turn into business.

If `Newsletter` and `Invoice` already exist but nothing recognises an inbound enquiry, add only
the missing observation and build on what is there:

```text
InboundEnquiry              detection   (new — the missing observation)
CommercialOpportunity       derived     (recommended: InboundEnquiry, Newsletter)
```

#### Say the model out loud when it is more than one label

When the model needs more than one label, describe it in two or three lines, then create it.
Do not wait for approval unless the user's intent is genuinely unclear:

> I would model this using two detection labels and one derived label:
>
> - `FlightCancellation`
> - `FlightDelay`
> - `TravelDisruption`
>
> This keeps the reusable observations separate from the higher-level interpretation.

When a single detection label is all it takes — "add a label for newsletters" — just create it
and report the result. No explanation, no options, no questions.

Guidance:

- Ask for anything missing rather than inventing it. A precise instruction describes the
  aspect being detected clearly enough to decide on a real message — at whatever breadth the
  user intends. Wording that sharpens that aspect belongs in the instruction ("invoices, but
  not payment reminders"); each label describes its own aspect and leaves the others to
  describe theirs.
- Take the aspect as the user frames it. If they describe something broad, keep it broad; if
  they describe several things they want as separate Gmail labels, create one label per Gmail
  label. The breadth is theirs to choose, so do not push toward finer or coarser labels. That
  is about breadth, not structure: splitting an interpretation into the observations it rests
  on is modelling, and it never narrows what the user asked for — they still get the label they
  named, and the supporting detection labels are what make it work.
- Configure the **logical** label, never the Gmail one. If the user says `IL/Invoices`, store
  `Invoices` — the CLI rejects anything starting with `IL/`, because it adds the namespace
  itself. Talk about labels the way the user does; just strip the prefix before it reaches
  `--label`.
- The logical labels `Processed` and `NoMatch` are reserved, since they resolve to Inbox
  Labeler's own `IL/Processed` and `IL/NoMatch`. The CLI rejects them on create and on update,
  in any casing. If a user asks for one, explain that Inbox Labeler uses it for its own state
  and agree on a different label rather than retrying.
- `--type` follows from the model you chose above, not from anything the user has to say. It
  defaults to `detection` and appears in the output either way, so the kind is never hidden.
- `--required-label` and `--recommended-label` are repeatable and take logical labels. On
  update they replace the stored list rather than adding to it; passing an empty value clears
  it. Both reject anything that is not an existing detection label, so create the detection
  labels first.
- **A label's type is immutable.** `update` refuses to turn a detection label into a derived one
  or the other way round. If the user wants the other kind, create a new label — and ask before
  deleting the old one, since its Gmail label disappears from their mail on the next reprocess.
- **A detection label cannot be deleted while a derived label references it.** `delete` refuses
  and names the derived labels involved. Nothing is cleaned up automatically: either update
  those derived labels to drop the reference, or delete them first. Tell the user which choice
  they are making rather than picking for them.
- Before deleting, confirm which label is meant if the reference is ambiguous.
- After a successful change, report the resulting label back to the user.

### Adding a label to an existing set

When the user wants another aspect detected, model it as above and create it. Existing labels
keep their instructions unchanged and the new ones take their place beside them — because
labelling is additive, adding a label never requires adjusting the others.

Labels that frequently land on the same mail while detecting different aspects are each doing
their own job, and both belong in the list. Two labels are the same label only when they detect
the same aspect — the same purpose and essentially the same instruction.

Names are unique (case-insensitive), so a create can fail on a name collision. That is a
naming clash about the `name` field alone: offer a different name, or ask whether the existing
label should be updated instead.

## Processing the inbox

Only do this when the user explicitly asks. There is no scheduler and nothing runs in the
background. Two commands exist:

| The user says | Command | Scope |
| --- | --- | --- |
| "process my inbox" | **process** | unread inbox messages **without** `IL/Processed` — new mail only |
| "reprocess my inbox" | **reprocess** | **every** unread inbox message, including those already processed |

Both commands run the same two stages per message — **detection first, then derived**:

```text
Email
  ↓
Detection labels
  ↓
IL/NoMatch          (when no detection label matched)
  ↓
Derived labels
  ↓
IL/Processed        (last, always)
```

`process` is the everyday run: it looks at mail Inbox Labeler has not seen yet and leaves
already-processed messages alone. `reprocess` re-evaluates everything against the current set
of detection labels and replaces each message's previous outcome — that is what makes it the
right choice after labels were added, changed, or deleted. Follow the flow that matches what
the user asked for, and if the wording is genuinely ambiguous, ask which one they mean rather
than guessing: `reprocess` rewrites Gmail labels that `process` would leave untouched.

Both commands share the same fundamentals. A **message** is the unit of work — never a
thread. Only unread inbox messages are ever touched, so archived mail and read mail are out of
scope in both commands. `IL/Processed` records that a message was evaluated and `IL/NoMatch`
records that the evaluation produced no matches. Unread is only a scope filter — **never
change the unread state** (no marking as read) and never treat unread as the processing state.

### process

1. Run `python3 labels.py list`. If it is empty, say so and stop. Resolve each label's logical
   label to its Gmail name — `Invoice` → `IL/Invoice` — and work with the resolved names from
   here on; Gmail knows nothing about logical labels.
2. Run `list_labels` and note the ids of `IL/Processed`, `IL/NoMatch` and every resolved
   business label. Create any that are missing with `create_label`, passing the resolved name
   (the `IL` parent is created automatically).
3. Find candidate threads with `search_threads`, query
   `in:inbox is:unread -label:<IL/Processed id>` — pass the label *id*, not the display
   name. If you just created `IL/Processed`, `in:inbox is:unread` is equivalent. Use
   `pageSize: 50`.
4. **Follow pagination to the end.** Keep calling `search_threads` with the returned
   `nextPageToken` until no next page token comes back. Process the complete result set —
   there is no cap on how many messages you handle, and no "first page only" shortcut.
   Narrow the query only if the user explicitly asked for a narrower scope (e.g.
   "everything from today" → add `newer_than:1d`).
5. For each thread, call `get_thread` and pick out the individual messages that are in the
   inbox, unread, and lack the `IL/Processed` id in `labelIds`. Gmail returns a whole thread
   when any one of its messages matches, so a result can mix in-scope and out-of-scope
   messages — check every message and skip the ones that do not qualify.
6. **Detection stage.** For each in-scope message, work through the whole list of detection
   labels and decide each one independently, keeping the ones whose aspect is present. Subject,
   sender and snippet are usually enough; use the full body from `get_thread` when they are not.
   The result is the complete set of triggered detection labels — empty, one, several, or all.
   Note one short reason per match: that is the **evidence**, and the derived stage needs it.
7. Apply the detection outcome with `label_message`, which branch depending on whether the set
   is empty:
   - **At least one detection label triggered** — apply the resolved business label of every
     triggered label. If the message still carries `IL/NoMatch` from an earlier run, remove it
     with `unlabel_message`: detection found matches now, so that outcome no longer holds.
   - **No detection label triggered** — apply `IL/NoMatch`.
8. **Derived stage.** Evaluate every derived label against the message, using the detection
   result as context — see [The derived-label prompt](#the-derived-label-prompt). Apply the
   resolved business label of each derived label that triggered. Skip a derived label whose
   `required_labels` did not all match; that is not a failure, it simply does not apply here.
9. Apply `IL/Processed` last, once both stages finished and every business label is in place.
   If either stage is incomplete or a labelling call fails, leave `IL/Processed` off so the
   message is picked up again on the next run.
10. Report a short summary: how many messages were processed, which message got which business
    labels and why, which got `IL/NoMatch`, and anything you were unsure about instead of
    guessing silently. Say which labels came from interpretation when a derived label triggered.

### reprocess

Use this when the user asks to reprocess, or to re-run the labels after changing them. The
governing idea:

> **Reprocess behaves as if Inbox Labeler had never seen the message before.**

Because Inbox Labeler owns the whole `IL/` namespace, achieving that needs no bookkeeping:
strip every `IL/` label off the message, then label it from scratch. There is no need to work
out which Gmail label came from which label, or which labels have since been changed or
deleted — anything in the namespace is Inbox Labeler's previous answer, and the previous answer
is being discarded.

1. Run `python3 labels.py list`. If it is empty, say so and stop — with no labels there is
   nothing to re-evaluate against. Resolve each logical label to its Gmail name as in
   `process` step 1.
2. Run `list_labels` and build the id map for the whole namespace: **every** label whose name
   starts with `IL/`, not just the ones you expect. Create any Gmail label a current label
   needs, plus `IL/Processed` and `IL/NoMatch`, with `create_label`.
3. Find candidate threads with `search_threads`, query `in:inbox is:unread`, `pageSize: 50`.
   There is deliberately no `-label:` filter: messages that already carry `IL/Processed` are
   included this time.
4. **Follow pagination to the end**, exactly as in `process` — keep calling `search_threads`
   with the returned `nextPageToken` until no next page token comes back, and handle the
   complete result set.
5. For each thread, call `get_thread` and pick out the messages that are in the inbox and
   unread. `IL/Processed` is not a disqualifier here, but read messages and messages outside
   the inbox still are, so check `labelIds` per message.
6. **Clear the namespace on that message.** Intersect its `labelIds` with the `IL/` ids from
   step 2 and remove all of them in **one** `unlabel_message` call. Every label outside the
   namespace is preserved untouched — Gmail's own labels and anything the user made stay
   exactly as they are. (`labelIds` holds ids, not names, which is why step 2 maps the whole
   namespace: an id you cannot resolve to an `IL/` name is not yours to remove.)
7. **Detection stage.** Evaluate the message against every current detection label
   independently, the same way as `process` step 6, keeping one line of evidence per match. The
   message now carries no `IL/` labels at all, so judge it purely on its own content — this is a
   first look, not a review of an earlier decision.
8. Apply the detection business labels with `label_message`: the resolved label of every
   triggered detection label. If no detection label matched, apply `IL/NoMatch`.
9. **Derived stage.** Evaluate every derived label with the detection result as context, exactly
   as in `process` step 8, and apply the resolved label of each one that triggered. A derived
   label whose `required_labels` did not all match is skipped.
10. Apply any resulting **bucket label**. Bucket labels do not exist in this version, so this
    step is a no-op today — when they arrive they slot in here, and step 6 already clears them
    for free because they live in the namespace.
11. Apply `IL/Processed` last, once both stages finished and every outcome label is in place.
12. Report a summary: how many messages were re-evaluated, what changed (labels gained, labels
    lost, `IL/NoMatch` set or cleared), what stayed the same, and any message you could not
    complete.

The outcome fully replaces the previous one, so a message that no longer matches `IL/Social`
loses it, a message that was `IL/NoMatch` and now matches `IL/Birthday` ends up with
`IL/Birthday` alone, a Gmail label whose label was deleted disappears, and a message whose
matches are unchanged ends up exactly as it was.

Failure handling is per message. If a call fails partway through a message, leave
`IL/Processed` off that message, report it, and carry on with the remaining messages — one
failure never aborts the run. A message left stripped and without `IL/Processed` is in a safe
state: the next `process` run picks it up again, because that is precisely its scope.

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

LargeAmount
Evidence: 1,450.00 EUR, over the 100 threshold

Task

Determine whether the following Derived Label applies.

Label:
LargePaymentNeedsAttention

Instruction:
A payment this large should be looked at before it is due.

Answer yes or no and explain briefly.
```

One derived label per prompt, one section per kind of input. `Detection Results` lists only
labels that matched, each with its evidence; if none matched, the section says so rather than
listing anything. The brief explanation is the derived label's own evidence — carry it into the
run summary the same way detection evidence is carried.

Treat the listed detection labels as established facts and reason from them — do not re-check
whether the email really is an invoice. The email is there for the details the labels do not
carry, like the due date or who sent it.

Keep each derived label's evaluation independent: one derived label's outcome is never input to
another. If a derived label needs a fact no detection label provides, the answer is a new
detection label, not a longer derived instruction.

Rules for both commands:

- **Detection first, derived second, always.** A derived label is never evaluated before the
  detection stage has finished for that message, because its input is the detection result.
- **Resolve logical labels once, then stay in Gmail terms.** Every Gmail call and every
  comparison against a message's `labelIds` uses the resolved `IL/…` name, and processing
  output names labels the way the user sees them in Gmail — report `IL/Invoice`, not `Invoice`.
  Logical labels belong to configuration; only the CLI deals in them.
- **Every message goes through the full list.** Each detection label gets its own decision for
  that message, and each one that triggers contributes its Gmail label. A message that triggers
  six labels gets six Gmail labels; how many a message ends up with is simply how many of the
  user's labels found their aspect in it.
- **`IL/NoMatch` reflects the detection stage.** A processed message carries either at least
  one detection business label or `IL/NoMatch`, never both. Derived labels do not affect it.
- **`IL/Processed` is always last and always earned.** Never leave it on a message whose
  evaluation did not complete successfully, in either command.
- **Removal is confined to the `IL/` namespace.** Inside it, anything may be removed —
  `reprocess` clears all of it, `process` drops a stale `IL/NoMatch`. Outside it, nothing is
  ever added or removed: Gmail's own labels (`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`,
  `CATEGORY_*`) and every user label are read-only. Never archive, mark as read, delete, or
  reply — labelling is the entire job.
- Work through the entire result set, however large, and label each message with everything
  it triggered. Neither a long list of messages nor a long list of labels on one message
  calls for stopping, sampling, or asking for confirmation.
- One failing message is not a failing run: report it and continue with the rest.
- If Gmail tools are unavailable, do not fake it: report which messages you cannot reach and
  present the labelling decisions as a plan, applying nothing.
