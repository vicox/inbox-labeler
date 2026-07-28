---
name: inbox-labeler
description: Manage persistent labels (a readable label, a type and an instruction) and apply them to inbox emails as Gmail labels on demand. Use when the user wants to create, change, rename, delete, list or inspect labels, or asks Inbox Labeler to process / label their inbox.
---

# Inbox Labeler

Inbox Labeler manages **labels**. Each one names the aspect of a message it detects and the
Gmail label to apply when that aspect is present:

| Field | Meaning |
| --- | --- |
| `label` | the label itself — its identity and its display text, e.g. `Delivery arriving soon` |
| `type` | how the label decides whether it applies: `detection` or `derived` |
| `instruction` | how you decide whether that aspect is present in a message, in natural language |
| `required_labels` | *derived only* — detection labels that must all have matched before this label is evaluated |
| `recommended_labels` | *derived only* — detection labels offered as context when they matched |

`label` holds the label only. `IL/` is Inbox Labeler's Gmail namespace — plumbing, not part of
a label's identity — so it never appears in stored configuration and is added only when talking
to Gmail: **`Delivery arriving soon` resolves to the Gmail label `IL/Delivery arriving soon`,
spaces and all.** Resolve in that direction every time you create a Gmail label, apply one,
remove one, compare one against a message's labels, or name one in output.

## Labels are identified by their text

A label's text is **the only identifier**. There is no separate name and no technical id: what
the user reads is what other labels reference and what `get`, `update` and `delete` address.

- **Write labels as ordinary phrases.** They **may contain spaces** and should read naturally:
  `Delivery arriving soon`, not `DeliveryArrivingSoon`. Capitalise the first word and leave the
  rest lowercase unless the words are proper nouns or an acronym — `BVK`, `VIP customer`,
  `PDF invoice` keep their capitals. Do not force title case.
- **References are exact label text.** A derived label names its detection labels by their
  label, spaces included: `required_labels: ["Delivery", "Imminent"]`.
- **Labels are unique, ignoring case.** `Delivery` and `delivery` are the same label, so a
  create that collides is rejected. The spelling you give is the spelling that is stored, and
  lookups match either way — `get "large amount"` finds `Large amount`.
- **Leading and trailing spaces are trimmed and inner runs collapse** to single spaces, so
  `"  Large   amount "` is stored as `Large amount`. Punctuation, digits and `&` are fine.
- **Renaming is `update <label> --label <new text>`**, and it rewrites every reference to that
  label in the same write. Renaming onto a label that already exists is rejected.
- **Lowercase is reserved for the system.** Inbox Labeler's own two labels are spelled
  `processed` and `nomatch`, and the lowercase form is what marks them as internal. User labels
  are readable phrases starting with a capital; nothing you create should imitate the system
  spelling.

## Label types

`type` is the label's kind. There are two, and both produce a Gmail label the same way — the
only difference is how they decide.

| Type | Question it answers |
| --- | --- |
| `detection` | *What can I directly observe in this email?* |
| `derived` | *Given the email and the detection labels that matched, what does this mean?* |

**Detection labels recognise facts. Derived labels interpret those facts.**

A detection label reads the email and decides. `Invoice`, `Newsletter`, `Login`,
`Large amount` are detection labels.

A derived label does **not** rediscover the email from scratch. It reads the email *together
with the detection labels that already matched* and decides what that combination means:

```text
Email
  ↓
Detection labels:  Invoice, Large amount
  ↓
Derived label:     Large payment needs attention
```

```text
Email
  ↓
Detection labels:  Travel booking, Flight cancellation
  ↓
Derived label:     Travel disruption
```

The email is still available when a derived label is evaluated. The detection labels are
structured context that makes the decision easier and more consistent — use them as given
facts rather than re-deriving them.

A derived label names the detection labels it builds on:

- **`required_labels`** — every one of them must have matched, or the derived label is not
  evaluated at all for that message. This is the gate.
- **`recommended_labels`** — helpful context. Include them in the prompt when they matched;
  when they did not, evaluate the derived label anyway.

Both hold **labels** (`Large amount`, not `IL/Large amount`), both may be empty, and both
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

## Labels are timeless

A label describes what an email **means**. It says nothing about whether that meaning is still
relevant today.

> **Evaluate every label as if you were reading the email at the moment it was written.**

- The current date and the current time never influence whether a label applies. Neither does
  how long ago the email arrived.
- The same email gets the same labels whether it is processed a minute after it lands or five
  years later.
- A relative date inside the email — "tomorrow", "in one hour", "next Tuesday" — is a fact
  *about the email*. Read it against the email's own date if you need to, never against now.

An email sent last week saying:

> Your package will arrive tomorrow.

can still correctly receive `Imminent`, because the arrival *was* imminent when the email was
written. The same goes for "Payment due tomorrow", "Meeting starts in one hour" and "Flight
departs today": each is a property of the email itself, so it stays true forever.

**"Is this still relevant?" is a different question at a different stage.** Labels like
`Needs attention today`, `Today` or `Expired` are prioritisation, not labelling — they compare the
email against the clock, and that comparison may legitimately belong to a later stage once one
exists. Detection labels and derived labels never make it. If a user asks for a label of that
kind, say so plainly and offer the timeless part instead: `Payment due soon` can be detected from
the email ("states a payment due within a few days of writing"), while whether that due date has
now passed cannot.

Time still has one legitimate role, and it is upstream of evaluation: **choosing which messages
to look at.** When the user asks to process "everything from today", narrowing the search is
selection, not evaluation — the labels each selected message then receives are unaffected by
when the run happens.

It also makes a run reproducible. Because evaluation does not depend on when it runs, the same
email evaluated twice yields the same labels — if an outcome ever differs, the labels changed,
never the clock.

## The `IL/` namespace

**Inbox Labeler owns the entire `IL/` namespace.** Every Gmail label whose name starts with
`IL/` is Inbox Labeler's to create, apply and remove — it is the whole of Inbox Labeler's
model, expressed as Gmail labels. The namespace is not a place for the user to keep labels of
their own: if they ask you to hand-create or hand-maintain one, explain that Inbox Labeler
manages that namespace and that the way to get a new `IL/` label is to add a label.

Every kind of Gmail label Inbox Labeler works with lives inside it:

| Kind | Origin | Logical label | Gmail label |
| --- | --- | --- | --- |
| **business labels** | the `label` of a detection or derived label | `Invoice`, `Large payment needs attention` | `IL/Invoice`, `IL/Large payment needs attention` |
| **bucket labels** | future label kind, not part of this version | — | — |
| **system labels** | Inbox Labeler's own state and outcome | `processed`, `nomatch` | `IL/processed`, `IL/nomatch` |

Both label types produce business labels; nothing in Gmail distinguishes a derived label's
output from a detection label's.

The two system labels:

| Gmail label | Meaning |
| --- | --- |
| `IL/processed` | Inbox Labeler has finished evaluating this message. |
| `IL/nomatch` | No **detection** label matched this message. |

`IL/processed` records **processing state** — that the work happened. `IL/nomatch` records
the **outcome** of detection — that no detection label matched. They serve different purposes
and are applied independently of one another.

`IL/nomatch` is about detection only, and is decided before derived labels are evaluated. So a
message can carry `IL/nomatch` together with a derived business label, in the one case where
that is possible: a derived label with no `required_labels` triggering on a message no detection
label matched. That is rare and it is correct — detection found nothing, interpretation found
something.

`processed` and `nomatch` are **reserved system labels**. The lowercase spelling is the
convention that marks them as internal: user labels are readable phrases, system labels are
not. The CLI rejects them on create, on rename and on delete, case-insensitively, so
`Processed` and `NOMATCH` are refused too. If a user asks for one, explain that it is Inbox
Labeler's own state rather than something a label can model, and agree on a different label.

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

# show one label — quote it, labels contain spaces
python3 labels.py get "Delivery arriving soon"

# create a detection label — --type defaults to detection
python3 labels.py create \
  --label "Invoice" \
  --instruction "The message is an invoice or bill for a purchase or service."

# create a derived label — repeat the reference flags for several labels
python3 labels.py create \
  --label "Large payment needs attention" \
  --type derived \
  --instruction "A payment this large should be looked at before it is due." \
  --required-label "Large amount" \
  --recommended-label "Invoice"

# update a label — pass only the fields that change
python3 labels.py update "Invoice" --instruction "Invoices and receipts, but not payment reminders."

# rename a label — every reference to it is rewritten in the same write
python3 labels.py update "Invoice" --label "Invoice or receipt"

# delete a label
python3 labels.py delete "Invoice or receipt"
```

`get`, `update` and `delete` address a label by its text, matched case-insensitively, so
`get "large amount"` finds `Large amount`. Always quote it — labels contain spaces. If the
user's wording does not match a stored label, run `list` and match it yourself; if several
plausibly fit, ask instead of guessing.

Every command prints JSON — including `type`, so the kind of label is always visible. On
failure it prints `{"error": "..."}` and exits non-zero.

### Modelling what the user asked for

The user describes a label they want. Working out *how* to model it is your job. Never ask
which type they want, never make them think about detection versus derived, and never default
to detection without looking at the concept first.

Start from meaning: **what would have to be true of an email for this label to belong on it?**

- If that can be recognised **directly in the email**, it is a **detection label** —
  `Invoice`, `Newsletter`, `Login`, `Flight cancellation`, `Large amount`.
- If it is an **interpretation of things already recognised**, it is a **derived label** —
  `Large payment needs attention`, `Travel disruption`, `Commercial opportunity`.

Aim for the smallest useful model — as few labels as express the idea, and no fewer. Then:

1. **Run `list` first.** The detection labels that already exist are your vocabulary. Reuse
   them instead of creating a near-duplicate: if `Large amount` is there, do not add `Big amount`.
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

Model the timeless meaning, not the current relevance. A concept that only makes sense relative
to today — `Expired`, `Still open`, `Needs attention today` — cannot be a label at all; see
[Labels are timeless](#labels-are-timeless) and offer the part that can be read off the email.

#### Example: an interpretation over new observations

> Create a label called Travel disruption for emails where a cancellation or severe delay is
> likely to disrupt a trip.

"Likely to disrupt a trip" is a judgement, not something you read off the page. The observable
facts are the cancellation and the delay, and *either* one alone can disrupt a trip — so they
are recommended, not required:

```text
Flight cancellation      detection
Flight delay             detection
Travel disruption        derived   (recommended: Flight cancellation, Flight delay)
```

#### Example: an interpretation over observations that must both hold

> Create a label called Large payment needs attention for invoices with unusually large amounts
> that should be reviewed.

Being an invoice and carrying a large amount are two separate observations, and here the user
wants both:

```text
Invoice                     detection
Large amount                 detection
Large payment needs attention  derived   (required: Invoice, Large amount)
```

Had they said "large payments, especially invoices", the amount would be the gate and the
invoice merely context: `required: Large amount`, `recommended: Invoice`.

#### Example: reuse instead of rebuilding

> Add Commercial opportunity for mail that might turn into business.

If `Newsletter` and `Invoice` already exist but nothing recognises an inbound enquiry, add only
the missing observation and build on what is there:

```text
Inbound enquiry              detection   (new — the missing observation)
Commercial opportunity       derived     (recommended: Inbound enquiry, Newsletter)
```

#### Say the model out loud when it is more than one label

When the model needs more than one label, describe it in two or three lines, then create it.
Do not wait for approval unless the user's intent is genuinely unclear:

> I would model this using two detection labels and one derived label:
>
> - `Flight cancellation`
> - `Flight delay`
> - `Travel disruption`
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
- Store the label, never the Gmail label. If the user says `IL/Invoices`, store `Invoices` —
  the CLI rejects anything starting with `IL/`, because it adds the namespace itself. Talk
  about labels the way the user does; just strip the prefix before it reaches `--label`.
- `processed` and `nomatch` are reserved system labels, since they resolve to Inbox Labeler's
  own `IL/processed` and `IL/nomatch`. The CLI rejects them on create, rename and delete, in
  any casing. If a user asks for one, explain that Inbox Labeler uses it for its own state and
  agree on a different label rather than retrying.
- `--type` follows from the model you chose above, not from anything the user has to say. It
  defaults to `detection` and appears in the output either way, so the kind is never hidden.
- `--required-label` and `--recommended-label` are repeatable and take the exact text of an
  existing detection label. On update they replace the stored list rather than adding to it;
  passing an empty value clears it. Create the detection labels first — a reference to a label
  that does not exist is rejected.
- **A label's type is immutable.** `update` refuses to turn a detection label into a derived one
  or the other way round. If the user wants the other kind, create a new label — and say that the
  old label's Gmail label stays on the mail that already carries it, since nothing revisits
  processed messages.
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

Labels are unique ignoring case, so a create can fail because that label already exists. Offer
a different wording, or ask whether the existing label should be updated instead. If the user
wants the existing label to read better, `update <label> --label <new text>` renames it and
carries every reference along.

## Processing the inbox

Only do this when the user explicitly asks. There is no scheduler and nothing runs in the
background. There is exactly one command:

| The user says | Command | Scope | Per run |
| --- | --- | --- | --- |
| "process my inbox" | **process** | unread inbox messages **without** `IL/processed` — new mail only | at most 10 |

It begins with a precondition — label definitions must be available, loaded from the Google
Drive Label Store if they are not here yet. See
[step zero](#step-zero-make-sure-labels-are-available). It stops after ten messages; see
[every run handles at most ten messages](#every-run-handles-at-most-ten-messages).

Each message then goes through two stages — **detection first, then derived**:

```text
Email
  ↓
Detection labels
  ↓
IL/nomatch          (when no detection label matched)
  ↓
Derived labels
  ↓
IL/processed        (last, always)
```

`process` looks at mail Inbox Labeler has not seen yet and leaves already-processed messages
alone. `IL/processed` is what keeps them out of scope, so a run never redoes work and later runs
continue with what is left — no cursor, no bookkeeping.

**Labelling only ever moves forward.** A message keeps the labels it was given, so editing or
deleting a label changes what *new* mail receives and leaves already-processed mail as it is. If
a user expects a change to reach mail that was labelled earlier, say plainly that it will not.

A **message** is the unit of work — never a
thread. Only unread inbox messages are ever touched, so archived mail and read mail are out of
scope in both commands. `IL/processed` records that a message was evaluated and `IL/nomatch`
records that the evaluation produced no matches. Unread is only a scope filter — **never
change the unread state** (no marking as read) and never treat unread as the processing state.

### Step zero: make sure labels are available

**Every command starts here.** Processing without label definitions is meaningless, so before
touching a single message, establish that they exist. This is the Inbox Labeler's job, not the
store's — the store loads and saves a file, it does not decide when to.

1. **Look locally first.** Run `python3 labels.py list`.
   - **Non-empty** → the definitions are already here. Continue with the flow below and do not
     go near Drive; the local store is what this run uses.
   - **Empty** → nothing is loaded yet. Go to step 2. (`labels.py` creates an empty store on
     first use, so an empty list means *not loaded*, not *no labels exist*.)
2. **Load from the Google Drive Label Store.** Use the `gdrive-label-store` skill, which finds
   the workspace folder, picks the newest `labels.json` and validates it before returning
   anything. Do not reach into Drive yourself and do not reimplement its rules.
3. **The store reports that no definitions exist** — no workspace folder, no `labels.json` in
   it, or a document holding zero labels. **Stop.** Tell the user plainly that no labels are
   configured, say which of those three it was, and offer to create some. Do not process
   anything and do not invent a starter set.
4. **The load succeeds.** Put the validated document in place as the local store, then run
   `python3 labels.py list` once to confirm the Inbox Labeler reads it. Continue with the flow
   below.
5. **The load fails for a technical reason** — the Drive connector is not connected, the grant
   sees nothing, the download breaks, the file is not valid JSON, or validation reports errors.
   **Report the error verbatim and stop.** Do not fall back to an empty store, do not process
   part of the inbox, and do not guess at definitions. A broken document is not the same as no
   document: definitions exist and something is wrong with them, which is the user's to fix.

The distinction between step 3 and step 5 is the one that matters. *Nothing configured* is a
normal state with an obvious next action; *something broken* must never be silently treated as
*nothing there*, because that would relabel a mailbox from an empty rulebook.

### Every run handles at most ten messages

**A run processes no more than ten messages, and then stops.** Fewer is fine: if only three are
eligible, a run handles three; if none are, it handles none. Everything beyond the tenth is
left alone.

The limit changes *how many* messages a run touches, never *which* ones. Selection, ordering
and the per-message rules are untouched — the run simply ends early.

Nothing is needed to keep the rest for later. An unhandled message never received
`IL/processed`, so it is still in scope exactly as it was, and the next run continues in the
same order. There is no cursor to keep and no state to write.

Always say how many you handled and whether more remain, so the user knows another run is
worth it.

### process

1. Complete [step zero](#step-zero-make-sure-labels-are-available). Then resolve each label to
   its Gmail name — `Large amount` → `IL/Large amount` — and work with the resolved names from
   here on; Gmail knows nothing about the unprefixed form.
2. Run `list_labels` and note the ids of `IL/processed`, `IL/nomatch` and every resolved
   business label. Create any that are missing with `create_label`, passing the resolved name
   (the `IL` parent is created automatically).
3. Find candidate threads with `search_threads`, query
   `in:inbox is:unread -label:<IL/processed id>` — pass the label *id*, not the display
   name. If you just created `IL/processed`, `in:inbox is:unread` is equivalent. Use
   `pageSize: 50`.
4. **Work through the pages in order, and stop at ten messages.** Keep calling `search_threads`
   with the returned `nextPageToken` while you still need messages; once ten have been
   processed, stop and fetch no further page. If the pages run out first, you are done — fewer
   than ten is fine, and so is none. Narrow the query only if the user explicitly asked for a
   narrower scope (e.g. "everything from today" → add `newer_than:1d`). That is selection; it
   does not change what any selected message means.
5. For each thread, call `get_thread` and pick out the individual messages that are in the
   inbox, unread, and lack the `IL/processed` id in `labelIds`. Gmail returns a whole thread
   when any one of its messages matches, so a result can mix in-scope and out-of-scope
   messages — check every message and skip the ones that do not qualify. Take them in the order
   the search returned them and count only the ones you actually process against the ten.
6. **Detection stage.** For each in-scope message, work through the whole list of detection
   labels and decide each one independently, keeping the ones whose aspect is present. Subject,
   sender and snippet are usually enough; use the full body from `get_thread` when they are not.
   The result is the complete set of triggered detection labels — empty, one, several, or all.
   Note one short reason per match: that is the **evidence**, and the derived stage needs it.
7. Apply the detection outcome with `label_message`, which branch depending on whether the set
   is empty:
   - **At least one detection label triggered** — apply the resolved business label of every
     triggered label.
   - **No detection label triggered** — apply `IL/nomatch`.
8. **Derived stage.** Evaluate every derived label against the message, using the detection
   result as context — see [The derived-label prompt](#the-derived-label-prompt). Apply the
   resolved business label of each derived label that triggered. Skip a derived label whose
   `required_labels` did not all match; that is not a failure, it simply does not apply here.
9. Apply `IL/processed` last, once both stages finished and every business label is in place.
   If either stage is incomplete or a labelling call fails, leave `IL/processed` off so the
   message is picked up again on the next run.
10. Report a short summary: how many messages were processed, which message got which business
    labels and why, which got `IL/nomatch`, and anything you were unsure about instead of
    guessing silently. Say which labels came from interpretation when a derived label triggered.
    **If the run stopped at the ten-message limit, say so** and that another `process` run will
    continue with the rest — otherwise the user has no way to tell a finished inbox from a
    truncated run.

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

One derived label per prompt, one section per kind of input. `Detection Results` lists only
labels that matched, each with its evidence; if none matched, the section says so rather than
listing anything. The brief explanation is the derived label's own evidence — carry it into the
run summary the same way detection evidence is carried.

Treat the listed detection labels as established facts and reason from them — do not re-check
whether the email really is an invoice. The email is there for the details the labels do not
carry, like the due date or who sent it. Read those details as they stood when the email was
written: a due date is a fact of the email, not something to compare against today's date.

Keep each derived label's evaluation independent: one derived label's outcome is never input to
another. If a derived label needs a fact no detection label provides, the answer is a new
detection label, not a longer derived instruction.

Rules while processing:

- **No labels, no processing.** Never touch a message before step zero has produced
  definitions. An empty rulebook does not mean "nothing matches" — it means the run should not
  have started, and treating the two alike would mark real mail as `IL/nomatch`.
- **Loading is the store's job, deciding is yours.** The Inbox Labeler decides *whether* to
  load, *when*, and what to do with each outcome. The `gdrive-label-store` skill only finds,
  validates and returns the file. Never put processing rules into it, and never bypass it by
  calling Drive tools from here.
- **Detection first, derived second, always.** A derived label is never evaluated before the
  detection stage has finished for that message, because its input is the detection result.
- **Judge every message as of the day it was written.** Neither stage consults the current date
  or time, and an email's age never changes what it means — see
  [Labels are timeless](#labels-are-timeless). The only time-dependent choice in a run is which
  messages to select, and only when the user asked for a narrower scope.
- **Resolve labels once, then stay in Gmail terms.** Every Gmail call and every comparison
  against a message's `labelIds` uses the resolved `IL/…` name, spaces included, and processing
  output names labels the way the user sees them in Gmail — report `IL/Large amount`, not
  `Large amount`. The unprefixed form belongs to configuration; only the CLI deals in it.
- **Every message goes through the full list.** Each detection label gets its own decision for
  that message, and each one that triggers contributes its Gmail label. A message that triggers
  six labels gets six Gmail labels; how many a message ends up with is simply how many of the
  user's labels found their aspect in it.
- **`IL/nomatch` reflects the detection stage.** A processed message carries either at least
  one detection business label or `IL/nomatch`, never both. Derived labels do not affect it.
- **`IL/processed` is always last and always earned.** Never leave it on a message whose
  evaluation did not complete successfully.
- **Labelling only ever adds.** No label is removed from any message, inside the `IL/` namespace
  or outside it. Gmail's own labels (`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, `CATEGORY_*`) and
  every user label are read-only, and so is anything Inbox Labeler applied on an earlier run.
  Never archive, mark as read, delete, or reply — labelling is the entire job.
- **Never stop for the wrong reason.** Ten messages is the only limit. Within a run, size is
  never a reason to pause: do not sample, do not ask for
  confirmation because the inbox is large, and do not cut a message short because it triggered
  many labels. Label each message with everything it triggered.
- One failing message is not a failing run: report it and continue with the rest.
- If Gmail tools are unavailable, do not fake it: report which messages you cannot reach and
  present the labelling decisions as a plan, applying nothing.
