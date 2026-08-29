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
| `attention` | what the label asks of the user: `none`, `normal` or `high`. Defaults to `normal` |
| `instruction` | how you decide whether that aspect is present in a message, in natural language |
| `required_labels` | *derived only* — detection labels that must all have matched before this label is evaluated |
| `recommended_labels` | *derived only* — detection labels offered as context when they matched |

`label` holds the label only. `IL/` is Inbox Labeler's Gmail namespace — plumbing, not part of a
label's identity — so it never appears in a stored label and is added only when talking to Gmail:
`Delivery arriving soon` becomes the Gmail label `IL/Delivery arriving soon`, spaces and all.
Adding it is the processing skill's business, not this one's.

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

# create a detection label — type defaults to detection
create_label   label:       "Invoice"
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
3. **Create the supporting detection labels first**, then the derived label. Its references must
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

**Create.** Supporting detection labels are created first, because a reference to a label that
does not exist is rejected and a label's type cannot be changed afterwards. `type` follows from
the model you chose, not from anything the user has to say; it defaults to `detection`. Store the
label, never the Gmail label: if the user says `IL/Invoices`, store `Invoices` — Inbox Labeler
rejects anything starting with `IL/`, because it adds the namespace itself.

**Update.** Pass only the fields that change. `required_labels` and `recommended_labels` replace
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
