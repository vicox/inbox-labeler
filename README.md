# Inbox Labeler

Two Claude Agent Skills for keeping persistent **labels** and applying them to Gmail inbox mail
on demand:

| Skill | Owns |
| --- | --- |
| **`inbox-labeler`** | the labels, and the Gmail work — `process` and `attention` |
| **`gdrive-label-store`** | the canonical `labels.json` in Google Drive — loading and saving it |

Nothing runs on its own. You ask, and something happens — see
[Automating it](#automating-it) if you would rather it happened hourly.

A label names the aspect of a message it detects, how to detect it, and the Gmail label to
apply when that aspect is present.

```json
{
  "label": "Delivery arriving soon",
  "type": "detection",
  "attention": "high",
  "instruction": "The message says a delivery is arriving today or in the next few days."
}
```

Each label also carries an **attention** level — what it asks of you. See
[Attention](#attention).

`label` is the label's **only identifier** — there is no separate name and no technical id.
It is a readable phrase, spaces and all, and it is what other labels reference and what
`get`, `update` and `delete` address.

`IL/` is Inbox Labeler's Gmail namespace — infrastructure, not part of a label's identity — so
it is stored nowhere and added only when talking to Gmail: `Delivery arriving soon` becomes
the Gmail label **`IL/Delivery arriving soon`**, spaces preserved.

Labels are unique ignoring case, and lookups are case-insensitive too, so
`get "delivery arriving soon"` finds it. Leading and trailing spaces are trimmed and inner
runs of whitespace collapse to one; punctuation and digits are fine.

Two labels are **not** yours: `processed` and `no-match` are reserved system labels, and the
lowercase spelling is the convention that marks them as internal. Your labels are readable
phrases — `Delivery`, `Large amount`, `Delivery arriving soon` — and keep their spelling
exactly as you write it. See [System labels](#system-labels).

## Attention

Labels say what a message *means*. **Attention** says what it asks of you — and it is the only
thing that lets Inbox Labeler touch your mailbox rather than just annotate it.

| Attention | What it does to the mail |
| --- | --- |
| `none` | marked read once the message is 24h old |
| `normal` | *(the default)* nothing at all |
| `high` | starred, and it stays starred |

Attention is **not** a label. It is computed per message from the labels that are on it, and the
**highest-priority one wins** — `high` > `none` > `normal`. One `high` label makes the message
`high`; failing that, one `none` label makes it `none`; otherwise it stays `normal`.

`normal` comes last because it is the absence of a request, not a request to be left alone: a
`Newsletter` label at `none` on the same message as an `Invoice` at `normal` still gets the mail
marked read, because `none` is the only thing either label actually asked for. A message with no
labels comes out `normal`, so it is left alone. The policies above are fixed and not configurable.

None of this happens on its own. **Say "apply attention"** and it runs over already-labelled
mail — unread messages carrying `IL/processed`. It reads the labels that are already there,
never the email, and it never adds or removes an Inbox Labeler label. `process` labels; `attention`
acts on those labels. Two commands, two jobs.

A label's own Attention also sets its Gmail label's **color**, using Gmail's muted palette so
it stays out of the way — `none` light gray, `normal` muted yellow, `high` muted red, from the
one mapping `labels.py` keeps for it. Color is purely
presentation: it never feeds back into what a label detects or how attention is computed, and
message processing never recolors a message — only the Gmail label itself, and only Detection
and Derived Labels get one; the reserved system labels never do. It's set the moment a Gmail
label is created and kept in sync whenever a label's Attention changes, so no color is ever
chosen or edited by hand.

## Label types

`type` says how a label decides whether it applies. There are two, and both produce a Gmail
label the same way — only the decision differs:

| Type | Question it answers |
| --- | --- |
| `detection` | *What can I directly observe in this email?* |
| `derived` | *Given the email and the detection labels that matched, what does this mean?* |

**Detection labels recognise facts. Derived labels interpret those facts.**

`Invoice`, `Newsletter`, `Login` and `Large amount` are detection labels: each reads the email
and decides. A derived label doesn't rediscover the email from scratch — it reads the email
*together with the detection labels that already matched* and decides what that combination
means:

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

A derived label names the detection labels it builds on:

```json
{
  "label": "Large payment needs attention",
  "type": "derived",
  "instruction": "A payment this large should be looked at, whether still due or already paid.",
  "required_labels": ["Large amount"],
  "recommended_labels": ["Invoice"]
}
```

References are the exact label text of an existing detection label — spaces included.

- **`required_labels`** — all of them must have matched, or the derived label isn't evaluated
  for that message. This is the gate.
- **`recommended_labels`** — context. Included in the prompt when they matched; when they
  didn't, the derived label is still evaluated.

Both hold labels (`Large amount`, not `IL/Large amount`), both may be empty, and both may
only point at detection labels — there is no chaining from one derived label to another. The
email is still available during evaluation; the detection labels are structured context that
makes the decision easier and more consistent.

Three rules keep the references honest:

- **A label's type is immutable.** You cannot turn a detection label into a derived one, or the
  reverse — create a new label instead.
- **A referenced detection label cannot be deleted.** If a derived label names it in
  `required_labels` or `recommended_labels`, the delete is rejected and tells you which derived
  label is in the way. Nothing is rewritten for you: drop the reference or delete the derived
  label first.
- **Renaming carries the references with it.** `update "Large amount" --label "Big amount"`
  rewrites every reference to it in the same write, so the store is never left dangling.
  Renaming onto a label that already exists is rejected.

### Asking for a label

You describe what you want and Inbox Labeler works out the model — you never pick a type.
Usually that is one detection label. When your request names several things that are each worth
detecting on their own, though, you get a detection label per concept plus one derived label
combining them, and you are told so in a line or two before anything is created:

> Create a label for invoices with unusually large amounts that should be reviewed.

becomes `Invoice` and `Large amount` as detection labels, with `Large payment needs attention`
derived on top — so the two observations are yours to reuse in other labels later. When the
parts are only ever wanted together — "login codes and password reset links" — it stays one
detection label with the detail in its instruction. Naming several things is not by itself a
reason to split; being useful apart is. The simplest model that keeps the pieces reusable wins.

## What a label is

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

A LinkedIn connection request, for example, carries several aspects at once: it is social
mail, it is a connection request, and you treat it as important. If you keep labels for all
three aspects, the message carries `IL/Social`, `IL/Connection` and `IL/Important` together.

The same holds at any breadth. Someone with `Invoice`, `Stripe` and `Reminder` labels sees all
three land on a Stripe invoice reminder. Someone who prefers a single `Billing` label covering
the same ground gets that one Gmail label instead. Both work the same way: every label that
triggers adds its Gmail label, and none of them displaces another.

## Layout

```
.claude/skills/inbox-labeler/
├── SKILL.md              instructions Claude follows
├── labels.py             the CRUD implementation (Python 3 stdlib, no dependencies)
├── test.sh               the test suite — runs in a temp dir, touches nothing real
├── labels.example.json   documentation only, never read at runtime
└── labels.json           the working copy — local, gitignored, created on first use
.claude/skills/gdrive-label-store/
├── SKILL.md              how to load and save the canonical labels.json in Drive
├── label_store.py        validation and stable serialisation
└── test.sh               its own test suite
README.md
```

Each skill is self-contained in its own directory.

## The `IL/` namespace

**Inbox Labeler owns the entire `IL/` namespace.** Every Gmail label starting with `IL/` is
Inbox Labeler's to create, apply and remove — the namespace *is* its model, expressed as Gmail
labels. Treat it as internal: don't create or maintain `IL/` labels by hand in Gmail, because
Inbox Labeler assumes everything there is its own. The way to get a new `IL/` label is to add a
label.

Because the namespace belongs to Inbox Labeler rather than to any individual label, it never
appears in configuration. Labels store the label itself (`Invoice`) and Inbox Labeler
resolves it to the **Gmail** label (`IL/Invoice`) whenever it creates, applies, removes,
compares or reports one:

| Kind | Origin | Label | In Gmail |
| --- | --- | --- | --- |
| **business labels** | the `label` of a detection or derived label | `Invoice`, `Large payment needs attention` | `IL/Invoice`, `IL/Large payment needs attention` |
| **system labels** | Inbox Labeler's own state and outcome | `processed`, `no-match` | `IL/processed`, `IL/no-match` |

Nothing in Gmail distinguishes a derived label's output from a detection label's — they are
both just business labels.

The boundary holds in both directions: **Inbox Labeler never modifies a Gmail label outside
`IL/`.** Everything out there belongs to Gmail or to you — `INBOX`, `UNREAD`, `STARRED`,
`IMPORTANT`, `CATEGORY_*`, and every label you made yourself. Those are read, never written.

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

## Where labels live

Two places, with one of them in charge:

| | |
| --- | --- |
| **Google Drive**, `Inbox Labeler/labels.json` | **canonical** — the definitions of record |
| `.claude/skills/inbox-labeler/labels.json` | the local working copy Claude reads while running |

The local copy is user-specific state and is **not** committed — it is in `.gitignore`, so the
repository holds only source, documentation and the example file.

**Loading is automatic, saving is not.** Before processing anything, Inbox Labeler checks the
local copy; if it is empty it loads the definitions from Drive through the
`gdrive-label-store` skill. If Drive has none either, it stops and says so rather than
processing with an empty rulebook. Changes you make with the CLI or by asking Claude land in
the local copy only — say **"save the labels"** to write them back to Drive.

Saving always creates a *new* `labels.json` in the Drive folder and the newest one is canonical;
older versions stay put. The Drive connector cannot update or delete a file in place, so
pruning old versions is a manual job in the Drive UI.

Nothing needs to be set up to start: the first `list` or `create` writes an empty local
`labels.json`. `labels.example.json` shows the file's shape and gives a feel for useful
instructions; it is never read at runtime, and deleting it changes nothing.

## How the skill is loaded

Claude Code discovers skills by directory, not by filename — a `SKILL.md` sitting at a
repository root is *not* picked up. It must be at
`<skills-dir>/<skill-name>/SKILL.md`, and there are two such locations:

**Project skill (how this repo is set up).** The skill is committed at
`.claude/skills/inbox-labeler/SKILL.md`, so it loads automatically for any Claude Code
session whose working directory is this project. No installation step:

```bash
cd /path/to/inbox-labeler
claude
```

Confirm it is loaded by running `/skills` (it appears as `inbox-labeler`), or just ask
"list my labels".

**Personal skill (available in every project).** Link or copy the skill directory into
your personal skills directory:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/.claude/skills/inbox-labeler" ~/.claude/skills/inbox-labeler
```

A symlink keeps one copy, so `labels.json` stays in this repo. Copy the directory instead if
you would rather the store live outside the project. Restart Claude Code after adding it.

Then say things like "add a label for invoices" or "list my labels" to manage them, and one of
these two to label mail:

| Say | What it does |
| --- | --- |
| **"process my inbox"** | labels unread inbox mail that hasn't been processed yet |
| **"apply attention"** | stars and marks read already-labelled mail, from the attention its labels carry |

Both use Claude's Gmail tools when they are connected; nothing runs on a schedule — you trigger
them, and `attention` never runs as part of `process`.

## What the two commands do

Both work on **individual messages**, not threads, and both are scoped to **unread inbox mail
only** — archived and read mail are never touched. Their scopes are mirror images and never
overlap:

| | Scope | Per run | What it writes |
| --- | --- | --- | --- |
| **`process`** | unread inbox mail **without** `IL/processed` | at most **10** | `IL/` labels |
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

## Automating it

Optional, and no part of the implementation — the skills themselves have no scheduler and never
act unprompted.

If you want it to happen regularly, set up a **recurring Claude task** with a prompt like:

```text
Process my inbox, then apply attention.
```

Hourly is a reasonable cadence: `process` handles up to ten messages per run, so an hourly task
keeps up with roughly 240 messages a day and works steadily through a backlog. The order
matters — `process` first, so the mail it just labelled falls into `attention`'s scope in the
same run rather than waiting an hour.

Everything the task needs must already be in place: the Gmail connector connected, and label
definitions either in the local copy or in Drive for step zero to load. A run with no
definitions stops and reports instead of doing anything.

## Run it directly

From `.claude/skills/inbox-labeler/`:

```bash
python3 labels.py list
python3 labels.py get "Large amount"

# a detection label
python3 labels.py create --label "Invoice" \
  --instruction "The message is an invoice or bill for a purchase or service."

# a derived label — the reference flags are repeatable
python3 labels.py create --label "Large payment needs attention" --type derived \
  --instruction "A payment this large should be looked at, whether still due or already paid." \
  --required-label "Large amount" --recommended-label "Invoice"

python3 labels.py update "Invoice" --instruction "The message is an invoice, bill or receipt."

# rename, rewriting every reference to it
python3 labels.py update "Large amount" --label "Big amount"

python3 labels.py delete "Invoice"

# set what a label asks of you
python3 labels.py update "Newsletter" --attention none
python3 labels.py update "Imminent" --attention high

# the two helpers the attention command uses — these touch nothing
python3 labels.py attention "Invoice" "Imminent"    # which level do these labels add up to?
python3 labels.py policy none --age 30h             # and what follows for a 30h old message?
python3 labels.py color high                        # which Gmail color does this level get?
```

`--label` takes the label itself — `Invoice`, not `IL/Invoice`. Anything starting with `IL/`
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

The `gdrive-label-store` skill has its own two commands, for checking a document by hand:

```bash
cd .claude/skills/gdrive-label-store
python3 label_store.py validate FILE            # every problem at once, not just the first
python3 label_store.py format   FILE [--write]  # stable, human-readable JSON
```

## Test it

No test framework, just a shell script per skill. Each copies its module into a temporary
directory, so your own labels are never touched:

```bash
.claude/skills/inbox-labeler/test.sh        # the labels, attention, and the documented flows
.claude/skills/gdrive-label-store/test.sh   # validation and serialisation
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
