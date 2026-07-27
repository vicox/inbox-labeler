# Inbox Labeler (local prototype)

A Claude Agent Skill for keeping persistent **labels** and applying them to Gmail inbox mail
on demand.

A label names the aspect of a message it detects, how to detect it, and the Gmail label to
apply when that aspect is present.

```json
{
  "label": "Delivery arriving soon",
  "type": "detection",
  "instruction": "The message says a delivery is arriving today or in the next few days."
}
```

`label` is the label's **only identifier** — there is no separate name and no technical id.
It is a readable phrase, spaces and all, and it is what other labels reference and what
`get`, `update` and `delete` address.

`IL/` is Inbox Labeler's Gmail namespace — infrastructure, not part of a label's identity — so
it is stored nowhere and added only when talking to Gmail: `Delivery arriving soon` becomes
the Gmail label **`IL/Delivery arriving soon`**, spaces preserved.

Labels are unique ignoring case, and lookups are case-insensitive too, so
`get "delivery arriving soon"` finds it. Leading and trailing spaces are trimmed and inner
runs of whitespace collapse to one; punctuation and digits are fine.

Two labels are **not** yours: `processed` and `nomatch` are reserved system labels, and the
lowercase spelling is the convention that marks them as internal. Your labels are readable
phrases — `Delivery`, `Large amount`, `Delivery arriving soon` — and keep their spelling
exactly as you write it. See [System labels](#system-labels).

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
└── labels.json           the store — local, gitignored, created on first use
README.md
docs/working/             the original build instruction
```

Everything the skill needs lives in its own directory.

## The `IL/` namespace

**Inbox Labeler owns the entire `IL/` namespace.** Every Gmail label starting with `IL/` is
Inbox Labeler's to create, apply and remove — the namespace *is* its model, expressed as Gmail
labels. Treat it as internal: don't create or maintain `IL/` labels by hand in Gmail, because a
reprocess will overwrite anything it finds there. The way to get a new `IL/` label is to add a
label.

Because the namespace belongs to Inbox Labeler rather than to any individual label, it never
appears in configuration. Labels store the label itself (`Invoice`) and Inbox Labeler
resolves it to the **Gmail** label (`IL/Invoice`) whenever it creates, applies, removes,
compares or reports one:

| Kind | Origin | Label | In Gmail |
| --- | --- | --- | --- |
| **business labels** | the `label` of a detection or derived label | `Invoice`, `Large payment needs attention` | `IL/Invoice`, `IL/Large payment needs attention` |
| **bucket labels** | future label kind, not in this version | — | — |
| **system labels** | Inbox Labeler's own state and outcome | `processed`, `nomatch` | `IL/processed`, `IL/nomatch` |

Nothing in Gmail distinguishes a derived label's output from a detection label's — they are
both just business labels.

The boundary holds in both directions: **Inbox Labeler never modifies a Gmail label outside
`IL/`.** Everything out there belongs to Gmail or to you — `INBOX`, `UNREAD`, `STARRED`,
`IMPORTANT`, `CATEGORY_*`, and every label you made yourself. Those are read, never written.

### System labels

| Gmail label | Meaning |
| --- | --- |
| `IL/processed` | Inbox Labeler has finished evaluating this message. |
| `IL/nomatch` | No **detection** label matched this message. |

They serve different purposes. `IL/processed` records **processing state** — that the work
happened. `IL/nomatch` records the **outcome of detection** — that no detection label matched.
A message that was processed and matched nothing carries both; a message that matched something
carries `IL/processed` alongside its business labels. `IL/nomatch` and detection business labels
never coexist on a message — the outcome is one or the other. Derived labels don't affect
`IL/nomatch`, since it is decided before they are evaluated.

`processed` and `nomatch` are **reserved system labels** — internal implementation detail, not
something a user models. `labels.py` rejects them on create, on rename and on delete, in any
casing, so `Processed` and `NOMATCH` are refused too.

`IL/nomatch` is what makes an empty result visible. Without it, a message that matched
nothing looks exactly like a message that was never processed once you stop looking at
`IL/processed` — with it, you can search `label:IL/nomatch` to see what your current labels
are missing, which is the fastest way to spot a gap worth a new label.

## Your labels stay local

`labels.json` is user-specific state and is **not** committed — it is listed in `.gitignore`.
The repository holds only source, documentation and the example file.

Nothing needs to be set up: the first `list` or `create` writes an empty `labels.json` if none
exists. `labels.example.json` is there to show the file's shape and to give a feel for useful
instructions; it is never read at runtime, and deleting it changes nothing. Copy it over your
store only if you want those examples as a starting point.

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
| **"reprocess my inbox"** | re-evaluates *every* unread inbox message against your current labels |

Both use Claude's Gmail tools when they are connected; nothing runs on a schedule — you
trigger it.

## process vs. reprocess

`process` is the everyday run. It skips anything already carrying `IL/processed`, so it only
ever looks at mail Inbox Labeler hasn't seen.

`reprocess` is for after you change your labels — added one, edited an instruction, deleted
one. It ignores `IL/processed` and re-evaluates every unread inbox message against the current
set. The rule it follows:

> **Reprocess behaves as if Inbox Labeler had never seen the message before.**

It gets there by stripping every `IL/` label off the message and labelling it from scratch.
Namespace ownership is what makes that safe — anything under `IL/` is Inbox Labeler's own
previous answer, and that answer is being discarded:

- a message that previously matched `IL/Social` but no longer does loses `IL/Social`
- a message that had `IL/nomatch` and now matches `IL/Birthday` ends up with `IL/Birthday`
- a Gmail label left over from a deleted or renamed label disappears
- a message whose matches are unchanged ends up exactly as it was

Practical consequences of the strip-and-relabel approach:

- **deleting a label cleans up after itself** — its Gmail label vanishes from your mail on the
  next reprocess, with no separate cleanup step
- **renaming a label leaves no orphans** — the old name is stripped like any other `IL/` label
- **future case and bucket labels participate automatically**, because they will live in the
  namespace and be cleared along with everything else
- **the model stays simple** — no record of which Gmail label came from which label, no
  versioning, no migrations; ownership of the namespace replaces all of that bookkeeping

Both commands share the same scope rules: **unread inbox messages only**. Archived mail and
read mail are never touched, and the unread state itself is never changed.

## How processing works

Processing works on individual **messages**, not threads, and records both its state and its
outcome with the two system labels:

- `process` takes unread inbox messages that have no `IL/processed`; `reprocess` takes every
  unread inbox message
- the complete result set is handled — pagination is followed until there is no next page,
  with no cap and no confirmation prompt for large runs
- `reprocess` first clears the message's `IL/` labels — all of them, whatever they are
- each message then goes through two stages, in this order:

```text
Email
  ↓
Detection labels      each decided independently against the email
  ↓
IL/nomatch            when no detection label matched
  ↓
Derived labels        each decided from the email + the detection labels that matched
  ↓
IL/processed          last, always
```

The detection stage behaves exactly as it always has. What it applies depends on whether
anything triggered:

| Detection outcome | Gmail labels applied |
| --- | --- |
| at least one detection label triggered | every triggered business label; a stale `IL/nomatch` is removed |
| nothing triggered | `IL/nomatch` |

Then the derived stage runs. A derived label whose `required_labels` didn't all match is
skipped; the rest are evaluated and each one that triggers adds its business label.

`IL/processed` always goes on last, once both stages have finished and the outcome labels are
in place — so an interrupted or failed run leaves the message to be picked up again. A failure
on one message is reported and the run continues with the rest.

Removal is confined to the `IL/` namespace: inside it anything may be cleared, outside it
nothing is ever added or removed.

Unread is only a scope filter: the unread state is never changed, and it is never used as
the processing state.

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
```

`--label` takes the label itself — `Invoice`, not `IL/Invoice`. Anything starting with `IL/`
is rejected, as are the reserved system labels `processed` and `nomatch`. Spaces are expected; quote the
argument.

`--type` defaults to `detection`, and every command prints the stored `type` so the kind of
label is always visible. An unknown type is rejected.

`--required-label` and `--recommended-label` apply to derived labels only and name existing
detection labels by their exact text. On update they replace the stored list rather than adding
to it; passing an empty value clears it.

`get`, `update` and `delete` address a label by its text, matched case-insensitively. Passing
`--label` to `update` renames the label. Every command prints JSON; on a validation failure it
prints `{"error": "..."}` and exits with status 1.

## Test it

There is no test framework, just a shell script. It copies `labels.py` into a temporary
directory, so your own labels are never touched:

```bash
.claude/skills/inbox-labeler/test.sh
```

It prints one line per check and exits non-zero if any fails. Coverage: store bootstrap, the
`type` field on create and through update, `list`/`get` exposing it, rejection of unknown types,
derived labels (creation, reference validation, updates, and detection labels staying
untouched), the documented detection→derived processing order, labels persisting without the
`IL/` prefix, logical→Gmail resolution, rejection of `IL/`-prefixed labels, rejection of
the reserved system labels in any casing, malformed labels, loading an older store, and the
pre-existing CRUD and validation behaviour.

Migration is worth knowing about, and there is no command to run for it. A store written by an
earlier version may carry a technical `id`, a separate `name`, an `IL/` prefix on the label, or
no `type` at all. Loading it drops the `id` and `name`, falls back to the old `name` if the
label is missing, strips one leading `IL/`, trims and collapses whitespace, and fills in
`type: detection` — all in memory, so `list` already shows the current shape and the next write
persists it. Turning a `CamelCase` label into a readable phrase is a rename you make
deliberately: `update "LargeAmount" --label "Large amount"`, which carries the references
along.

## Scope

Deliberately small: local JSON storage, no database, no server, no auth, no scheduler,
no UI. Gmail work happens through Claude's Gmail tools as described in `SKILL.md`.
