---
name: inbox-labeler-manage
description: Create, inspect, model, update, rename, and delete Inbox Labeler labels using the Inbox Labeler MCP server. Use when the user wants to manage what Inbox Labeler detects, how labels are interpreted, or what attention they request.
---

# Inbox Labeler — manage labels

One job: the labels themselves — creating, inspecting, modelling, updating, renaming and
deleting them. This never touches mail. Processing an inbox belongs to `inbox-labeler-process`,
and acting on Attention belongs to `inbox-labeler-attention`.

Each label names the aspect of a message it detects:

| Field | Meaning |
| --- | --- |
| `label` | the label itself — its identity and its display text, e.g. `Delivery arriving soon` |
| `type` | how the label decides whether it applies: `detection` or `derived` |
| `role` | *detection only* — what kind of fact it is: `category` or `attribute` |
| `attention` | what the label asks of the user: `none`, `normal` or `high`. Defaults to `normal` |
| `instruction` | how you decide whether that aspect is present in a message, in natural language |
| `required_labels` | *derived only* — detection labels that must all have matched before this label is evaluated |
| `recommended_labels` | *derived only* — detection labels offered as context when they matched |

`label` holds the label only. `IL/` is Inbox Labeler's Gmail namespace — plumbing, not part of a
label's identity — so it never appears in a stored label and is added only when talking to Gmail:
`Delivery arriving soon` becomes the Gmail label `IL/Delivery arriving soon`, spaces and all.
Adding it is the processing skill's business, not this one's.

**Inbox Labeler owns the whole `IL/` namespace in Gmail.** Every label under it belongs to Inbox
Labeler, and it is not somewhere the user keeps labels of their own. Hand-creating, hand-editing
and hand-removing `IL/` labels are all outside how Inbox Labeler is managed: if the user asks for
any of them, explain that Inbox Labeler manages that namespace, and that the way to get a new one
is to create the label here — processing puts the matching Gmail label in place on its next run.

**The tools here are Inbox Labeler's MCP tools** — `get_labels`, `create_label`, `update_label`,
`delete_label` — and they act on **label definitions**. A Gmail connector usually exposes tools
with three of those names that act on **Gmail labels**; they are different things, and confusing
them writes to the wrong place. Nothing in this skill touches Gmail. Identity is the
authenticated MCP session: never ask the user for an account id and never pass one to any tool.

## Labels are identified by their text

A label's text is **the only identifier**. There is no separate name and no technical id: what
the user reads is what other labels reference and what `update_label` and `delete_label` address.

- **Write labels as ordinary phrases.** They **may contain spaces** and should read naturally:
  `Delivery arriving soon`, not `DeliveryArrivingSoon`. Capitalise the first word and leave the
  rest lowercase unless the words are proper nouns or an acronym — `BVK`, `VIP customer`,
  `PDF invoice` keep their capitals. Do not force title case.
- **References are exact label text**, spaces included:
  `required_labels: ["Delivery", "Imminent"]`.
- **Labels are unique, ignoring case.** `Delivery` and `delivery` are the same label, so a create
  that collides is rejected. The spelling you give is the spelling that is stored, and lookups
  match either way — asking for `"large amount"` finds `Large amount`.
- **Leading and trailing spaces are trimmed and inner runs collapse** to single spaces, so
  `"  Large   amount "` is stored as `Large amount`. Punctuation, digits and `&` are fine.
- **Renaming is `update_label` with `new_label`**, and it rewrites every reference to that label
  in the same write. Renaming onto a label that already exists is rejected.
- **Lowercase is reserved for the system.** Inbox Labeler's own two labels are spelled
  `processed` and `no-match`, and the lowercase form is what marks them as internal. User labels
  are readable phrases starting with a capital; nothing you create should imitate the system
  spelling. Inbox Labeler rejects them on create, on rename and on delete, case-insensitively, so
  `Processed` and `NO-MATCH` are refused too. If a user asks for one, explain that it is Inbox
  Labeler's own state rather than something a label can model, and agree on a different label.

## Label types

`type` is the label's kind. There are two, and the only difference is how they decide.

| Type | Question it answers |
| --- | --- |
| `detection` | *What can I directly observe in this email?* |
| `derived` | *Given the email and the detection labels that matched, what does this mean?* |

**Detection labels recognise facts. Derived labels interpret those facts.** A detection label
reads the email and decides — `Invoice`, `Newsletter`, `Login`, `Large amount`. A derived label
does **not** rediscover the email from scratch: it reads the email *together with the detection
labels that already matched* and decides what that combination means. The email is still
available when a derived label is evaluated; the matched detection labels are structured context
to be used as **given facts** rather than re-derived.

A derived label names the detection labels it builds on:

- **`required_labels`** — every one of them must have matched, or the derived label is not
  evaluated at all for that message. This is the gate.
- **`recommended_labels`** — helpful context. They are included when they matched; when they did
  not, the derived label is evaluated anyway.

Both hold labels (`Large amount`, not `IL/Large amount`), both may be empty, and both may only
point at detection labels. A derived label with no `required_labels` is evaluated for every
message. Derived labels never reference other derived labels — there is no chaining, and Inbox
Labeler rejects it. Inbox Labeler rejects any type other than `detection` and `derived`; do not
invent a third.

## Category or attribute

Every detection label says two things: that it found something, and what kind of something it
found. The second is its **role**, and there are two — no more.

| Role | What it tells you about the message |
| --- | --- |
| `category` | what the message **fundamentally is, or is about** — a kind, a subject, a classification |
| `attribute` | something **additionally true about** the message — a property, state, characteristic, urgency, requirement or signal |

`Invoice`, `Newsletter`, `Delivery`, `Travel`, `Social` are categories: each one, when it matches,
answers *what is this mail*. `Action required`, `Informational`, `Imminent`, `Large amount`,
`Discount` are attributes: not one of them says what the mail is, and each qualifies whatever it
turns out to be.

### The test: what does the match contribute?

Ask what the label tells you at the moment it matches.

- *This is what the mail is, or is about* → **category**
- *This is additionally true of the mail* → **attribute**

Or shorter, if it helps: **a category is a classification, an attribute is a qualifier.**
Classification, subject, kind on one side; qualifier, property, state, characteristic on the
other.

This is a modelling distinction and not a universal ontology. It describes how one account chose
to think about its own mail, and two accounts may reasonably differ.

### Categories are not one exclusive dimension

Several categories can match one message, and that is ordinary rather than a modelling error.
`Travel` and `Invoice` both match a travel invoice. `Social` and `Newsletter` both match a
mailing list digest from a social network. `Wohnung` and `Delivery` both match a parcel notice
about the flat.

None of those pairs means one of the two must give way and become an attribute. Both are saying
what the mail is, and mail is allowed to be more than one thing. There is **no primary
category**: nothing ranks them, nothing picks one, and a message may match several, exactly one,
or none at all. Several attributes may match alongside them, or none. A message matching nothing
is a normal outcome.

### The role comes from the instruction, not the name

A label name on its own does not fix its role. Concepts like `Booking confirmation`, `Birthday`,
`Calendar event`, `Connection`, `Login`, `Marketing` and `Policy update` have no universally
correct role, and this skill does not pretend they do — the role belongs to what the detection
instruction is meant to establish.

`Booking confirmation` shows both readings. An instruction meaning *this mail is a booking
confirmation* is a classification of the mail: `category`. An instruction meaning *a confirmed
booking is mentioned here, whatever else this mail is* adds a fact to mail that is about something
else: `attribute`. Same name, two different labels, and only the instruction says which was
intended.

So when you settle the role of a label that already exists, read its instruction and ask what it
establishes. Do not work backwards from the name.

### When it is genuinely unclear, ask

A new detection label cannot be created without a role, so the role has to be settled first — but
settling it is not the same as guessing it. When the instruction the user has in mind would
support either reading, say what the two readings are, in a line or two, and let them choose:

> Do you mean `Receipts` as a classification — this mail is a receipt — or as a qualifier, a
> receipt being present in mail that is about something else? The first is a `category`, the
> second an `attribute`.

Do not present a coin-flip as a decision, and do not model around the ambiguity by creating both.
One label, one role, chosen by the person whose mail it is.

### Three things the role is not

- **Not exclusive.** One message can match several categories and several attributes at once. A
  travel invoice with a deadline matches `Travel`, `Invoice` and `Deadline`, and nothing about
  that is a conflict.
- **Not part of matching.** Each detection label is still decided on its own, by its own
  instruction. The role changes what kind of fact a match *is*, never whether it matched or what
  it took to match.
- **Not a reason to split a label.** Do not invent a near-duplicate so that each role has one —
  `Invoice` the category does not need an `Invoice received` attribute beside it. One label per
  aspect, and the role describes the aspect you already have.

**Why getting it right matters anyway.** A wrong role breaks nothing today, precisely because it
changes nothing about matching — it costs later. Roles are what make it possible to notice that a
message came out of a run carrying three attributes and nothing that says what it is. That is a
real gap, and it is visible only where the labels carrying a classification are recorded as such.
Such a gap means no matched label meaningfully says what the mail is. It does not mean that some
broader heading is missing above the labels you already have: `Invoice` is a complete answer to
*what is this mail*, and nothing here asks you to find something larger to file it under.

**Derived labels have no role.** A derived label is already an interpretation of detection facts,
so asking what kind of fact it is has no answer, and Inbox Labeler refuses one. Its
`required_labels` and `recommended_labels` may name detection labels of either role freely, and
**the roles place no constraint on the composition.** Two categories, two attributes, one of each,
a single detection label or five of them are all structurally valid; what makes one of them right
is the conclusion you are drawing, never an arithmetic of roles. A starter set that happens to
pair one category with one attribute is a handful of examples, not a shape to copy.

**A role can be changed; a type cannot.** Deciding later that a label you modelled as a
classification is really a qualifier — or the other way round — is a revised judgement rather
than a different label, so `update_label` accepts it. See
[Classification changes reach new mail only](#classification-changes-reach-new-mail-only) for what
that does and does not reach.

### Labels from before the distinction

An account may hold detection labels with no role at all. Those were modelled before the
distinction existed; they are read, matched and referenced exactly as they always were, and a
missing role means **nobody has decided yet** — not that the label is broken, and not that it
defaults to anything.

When you list labels and see one, say so and offer to settle it — "`Newsletter` has no role yet;
its instruction says the mail *is* a newsletter, which is a classification, so `category` — shall
I set it?" — and set it with `update_label`. Never assign a role to an existing label without the
user agreeing, and never work one out from
the label name or instruction and write it silently. An unrelated edit is not the moment either:
changing an instruction leaves a missing role exactly as it was, which is deliberate, so editing
one thing never becomes a modelling decision the user did not make.

## The instruction is the rule

`instruction` is not a description of the label — it is the natural-language rule a processing
run later applies to a real message to decide whether the label applies. Write it precisely
enough for that decision to be made on a real message, and **take the aspect as the user frames
it**: broad if they describe it broadly, narrow if narrowly. Wording that sharpens the aspect
belongs in the instruction ("invoices, but not payment reminders"), each label describing its own
aspect and leaving the others to describe theirs. Never invent criteria the user did not ask for
— ask for anything missing instead.

## Labels are timeless

A label describes what an email **means**, not whether that meaning is still relevant today, so
an instruction must be readable against the email itself and never against the clock. An email
saying "your package will arrive tomorrow" can carry `Imminent` for ever, because the arrival
*was* imminent when it was written. A concept that only makes sense relative to today —
`Expired`, `Still open`, `Needs attention today` — cannot be a label at all. Say so plainly and
offer the timeless part instead: `Payment due soon` can be read off an email ("states a payment
due within a few days of writing"); whether that due date has now passed cannot.

## Attention is part of the definition

`attention` is what a label asks of the user, stored on the label:

| Level | What the label is saying |
| --- | --- |
| `none` | the user never needs to see this |
| `normal` | *(the default)* leave the message alone |
| `high` | important, and stays important |

Choose it from what the user wants the label to *ask for*, and store it. **Carrying it out is not
this skill's job** — `inbox-labeler-attention` reads these values and acts on mail. Nothing here
stars a message, changes a read state, or looks at mail at all.

## Managing labels

```text
# list every label
get_labels

# create a detection label — type defaults to detection; role is required
create_label   label:       "Invoice"
               role:        "category"
               instruction: "The message is an invoice or bill for a purchase or service."

# create a derived label — the reference lists take several labels
create_label   label:               "Large payment needs attention"
               type:                "derived"
               instruction:         "A payment this large should be looked at before it is due."
               required_labels:     ["Large amount"]
               recommended_labels:  ["Invoice"]

# update a label — pass only the fields that change
update_label   label:       "Invoice"
               instruction: "Invoices and receipts, but not payment reminders."

# settle or revise a detection label role
update_label   label: "Marketing"
               role:  "attribute"

# rename a label — every reference to it is rewritten in the same write
update_label   label:     "Invoice"
               new_label: "Invoice or receipt"

# delete a label
delete_label   label: "Invoice or receipt"
```

`update_label` and `delete_label` address a label by its text, matched case-insensitively, so
`"large amount"` finds `Large amount`. If the user's wording does not match a stored label, call
`get_labels` and match it yourself; if several plausibly fit, ask instead of guessing. There is no
tool that fetches one label — `get_labels` returns them all, and you pick.

Every tool answers with the resulting label — including `type`, so the kind of label is always
visible. On failure it answers with the reason instead. After a successful change, report the
resulting label back to the user.

## Modelling what the user asked for

The user describes a label they want. Working out *how* to model it is your job. Never ask which
type they want, never make them think about detection versus derived, and never default to
detection without looking at the concept first.

Start from meaning: **what would have to be true of an email for this label to belong on it?**

- If that can be recognised **directly in the email**, it is a **detection label** — `Invoice`,
  `Newsletter`, `Login`, `Flight cancellation`, `Large amount`.
- If it is an **interpretation of things already recognised**, it is a **derived label** —
  `Large payment needs attention`, `Travel disruption`, `Commercial opportunity`.

Then ask **how many concepts the request contains.** One request does not imply one label:
"invoices with unusually large amounts", "a cancellation or severe delay that ruins a trip" and
"login codes and password reset links" all name more than one thing, and only some of them should
become more than one label. Put every concept you find through the reuse question:

> Would this concept be worth detecting on its own, on mail that has nothing to do with the rest
> of this request?

- **Yes, for more than one of them** — model each as its own detection label, and add a derived
  label on top when the combination carries meaning or behaviour the parts do not: its own name,
  its own interpretation, or its own attention.
- **No** — the concepts are one aspect described in several words. Model it as a single detection
  label and let the instruction carry the detail.

**Several concepts mentioned is not a reason to split — several concepts reusable apart is.**
When splitting would buy no reuse, it only buys labels nobody wanted. Prefer the simplest model
that preserves reuse: as few labels as express the idea, and no fewer. Then:

1. **Call `get_labels` first.** The detection labels that already exist are your vocabulary.
   Reuse them instead of creating a near-duplicate: if `Large amount` is there, do not add
   `Big amount`.
2. **Name the observations the concept rests on.** When the user's label is an interpretation and
   the observations it needs do not exist yet, those become supporting detection labels.
3. **Decide each detection label's role before creating it** — `category` when the label says what
   the mail fundamentally is, `attribute` when it says something additionally true about the mail.
   See [Category or attribute](#category-or-attribute). A new detection label without one is
   refused, and rightly: it is part of what the label means rather than a field to fill in later.
4. **Create the supporting detection labels first**, then the derived label. Its references must
   already exist, and a label's type cannot be changed afterwards — so decide the shape before
   creating anything.

Choosing between the two reference lists follows from the user's wording. **`required_labels` is
an AND gate** — every one of them must have matched — so use it for observations that all have to
hold. **`recommended_labels` is context** — any subset may be present — so use it when one
observation *or* another is enough to make the interpretation worth considering, and let the
instruction weigh them.

**A derived label should be able to say no.** The required labels decide which messages are
considered; the instruction decides which of those the label belongs on. Put every derived label
through the rejection question:

> Is there a message where every required label matches and this label still does not belong?

A label that answers no is not interpreting anything: its instruction restates the conjunction,
and what it really adds is a threshold or an attention level. That can be worth having, but say
which of the two it is rather than presenting it as a new concept.

If an interpretation seems to need another interpretation, the missing piece is a detection label
— derived labels never reference derived labels.

### Example: an interpretation over new observations

> *Create a label called Travel disruption for emails where a cancellation or severe delay is
> likely to disrupt a trip.*

"Likely to disrupt a trip" is a judgement, not something you read off the page. The observable
facts are the cancellation and the delay, and *either* one alone can disrupt a trip — so they are
recommended, not required:

```text
Flight cancellation      detection
Flight delay             detection
Travel disruption        derived   (recommended: Flight cancellation, Flight delay)
```

### Example: an interpretation over observations that must both hold

> *Create a label called Large payment needs attention for invoices with unusually large amounts
> that should be reviewed.*

Being an invoice and carrying a large amount are two separate observations, and here the user
wants both, so both are required:

```text
Invoice                        detection
Large amount                   detection
Large payment needs attention  derived   (required: Invoice, Large amount)
```

Had they said "large payments, especially invoices", the amount would be the gate and the invoice
merely context: `required: Large amount`, `recommended: Invoice`.

### Example: several concepts, still one label

> *Create a label called Login for login codes and password reset links.*

Two concepts, and neither answers the reuse question — nobody wants login codes labelled apart
from password resets. They are one aspect, and the instruction carries the detail a split would
have expressed:

```text
Login    detection   ("The message carries a login code, a sign-in link or a password reset.")
```

## Creating, updating, deleting

**Create.** Every detection label needs its role — `category` or `attribute` — and a derived
label must not be given one. Supporting detection labels are created first, because a reference to
a label that does not exist is rejected and a label's type cannot be changed afterwards. `type` follows from
the model you chose, not from anything the user has to say; it defaults to `detection`. Store the
label, never the Gmail label: if the user says `IL/Invoices`, store `Invoices` — Inbox Labeler
rejects anything starting with `IL/`, because it adds the namespace itself.

**Update.** Pass only the fields that change. A detection label's `role` is among them: pass it
to settle one that has none, or to move a label between `category` and `attribute`. Leaving it out
changes nothing about it. `required_labels` and `recommended_labels` replace
the stored list rather than adding to it, and passing an empty list clears it. **A label's type is
immutable** — `update_label` refuses to turn a detection label into a derived one or the other way
round. If the user wants the other kind, create a new label, and say that the old label's Gmail
label stays on the mail that already carries it, since nothing revisits processed messages.

**Rename** with `new_label`. Every reference to the label is rewritten in the same write. Renaming
onto a label that already exists is rejected — offer a different wording, or ask whether the
existing label should be updated instead.

**Delete.** A **detection label cannot be deleted while a derived label references it**:
`delete_label` refuses and names the derived labels involved. Nothing is cleaned up automatically
— either update those derived labels to drop the reference, or delete them first. **Tell the user
which choice they are making rather than picking for them.** Before deleting, confirm which label
is meant if the reference is ambiguous. Reserved system labels cannot be deleted.

### Classification changes reach new mail only

**Labelling only ever moves forward.** A message that has been processed is never revisited, so
changing what a label detects changes what Inbox Labeler will apply **next** and leaves the
mailbox as it is. An edited instruction does not re-judge a message it was applied to. A changed role does not
re-read facts already recorded, does not touch a Gmail label and does not adjust a derived label
that references it. A deleted
label does not come off the mail carrying its Gmail label. A changed reference list does not undo
an interpretation it fed. A rename is the same: references to it are rewritten, and the Gmail
label already sitting on a message is not. There is no backfill and no cleanup step, and the
business labels already on a message stay as they are.

So when a user expects a change of this kind to reach mail they have already had labelled — "now
fix the old ones" — **say plainly that it will not**, and that it applies from the next processing
run onwards.

**Attention metadata is the exception.** `attention` is not part of what a label detects: it is
what the label *asks for*, and `inbox-labeler-attention` reads it fresh from `get_labels` every
time it runs, against mail that is already processed and still unread. Raising a label from
`normal` to `high` therefore changes nothing by itself and starts nothing — that run never happens
automatically — but the next one **the user explicitly asks for** will use the new level, and a
message processed under the old one may come out starred. Say so when that is what the user is
asking about.

## Adding a label to an existing set

When the user wants another aspect detected, model it as above and create it. Existing labels keep
their instructions unchanged and the new ones take their place beside them — because labelling is
additive, adding a label never requires adjusting the others. Labels that frequently land on the
same mail while detecting different aspects are each doing their own job, and both belong in the
list. Two labels are the same label only when they detect the same aspect — the same purpose and
essentially the same instruction.

## How much to say

When a single detection label is all it takes — "add a label for newsletters" — just create it
and report the result: no explanation, no options, no questions. When the model needs more than
one label, describe it in two or three lines and then create it, without waiting for approval
unless the user's intent is genuinely unclear:

> I would model this using two detection labels and one derived label: `Flight cancellation`,
> `Flight delay` and `Travel disruption`. This keeps the reusable observations separate from the
> higher-level interpretation.

Ask only for information genuinely missing. Never make the user choose between detection and
derived, or between required and recommended — those follow from what they described, and
deciding them is this skill's job.
