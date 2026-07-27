# Inbox Labeler (local prototype)

A Claude Agent Skill for keeping persistent **label requests** and applying them to
Gmail inbox mail on demand.

A label request names the aspect of a message it detects, how to detect it, and the Gmail
label to apply when that aspect is present.

```json
{
  "id": "8da8071c",
  "name": "Invoice",
  "label": "IL/Invoice",
  "instruction": "The message is an invoice or bill for a purchase or service."
}
```

## What a label request is

> A user-defined way to detect an aspect of a message that is interesting to the user.

That aspect can be as broad or as narrow as you like. `IL/Social` for everything from a
social platform is a perfectly good label request; so is `IL/Connection` for connection
requests specifically. You can have both. Your choice of label requests *is* the model —
Inbox Labeler has no opinion on how fine-grained they should be.

What matters is how label requests behave together:

- **Independent.** Each label request is evaluated on its own. Whether it triggers depends
  on two things only: the message, and its own instruction.
- **Any number may trigger.** A message triggers as many label requests as have their
  aspect present — none, one, several, or all of them.
- **Every trigger produces a label.** Each label request whose aspect is present
  contributes its Gmail label to the message.
- **Additive, not alternatives.** For a given message the outcome is the complete set of
  triggered label requests, and the labels applied are exactly that set.

A LinkedIn connection request, for example, carries several aspects at once: it is social
mail, it is a connection request, and you treat it as important. If you keep label requests
for all three aspects, the message carries `IL/Social`, `IL/Connection` and `IL/Important`
together.

The same holds at any breadth. Someone with `IL/Invoice`, `IL/Stripe` and `IL/Reminder` sees
all three land on a Stripe invoice reminder. Someone who prefers a single `IL/Billing`
request covering the same ground gets that one label instead. Both work the same way: every
label request that triggers adds its label, and none of them displaces another.

## Layout

```
.claude/skills/inbox-labeler/
├── SKILL.md                      instructions Claude follows
├── label_requests.py             the CRUD implementation (Python 3 stdlib, no dependencies)
├── label-requests.example.json   documentation only, never read at runtime
└── label-requests.json           the store — local, gitignored, created on first use
README.md
docs/working/                     the original build instruction
```

Everything the skill needs lives in its own directory. Labels always live under the
`IL/` namespace so Inbox Labeler never touches labels it did not create.

## System labels

Two labels in that namespace belong to Inbox Labeler itself rather than to any label request:

| Label | Meaning |
| --- | --- |
| `IL/Processed` | Inbox Labeler has finished evaluating this message. |
| `IL/NoMatch` | None of the current label requests matched this message. |

They serve different purposes. `IL/Processed` records **processing state** — that the work
happened. `IL/NoMatch` records the **outcome** — that the evaluation found nothing. A message
that was processed and matched nothing carries both; a message that matched something carries
`IL/Processed` alongside its business labels. `IL/NoMatch` and business labels never coexist
on a message — the outcome is one or the other.

Every other `IL/` label comes from a label request and says something about the message
itself — those are the **business labels**. The two system labels are reserved, and
`label_requests.py` rejects them as a `label` value on both create and update.

`IL/NoMatch` is what makes an empty result visible. Without it, a message that matched
nothing looks exactly like a message that was never processed once you stop looking at
`IL/Processed` — with it, you can search `label:IL/NoMatch` to see what your current label
requests are missing, which is the fastest way to spot a gap worth a new label request.

## Your label requests stay local

`label-requests.json` is user-specific state and is **not** committed — it is listed in
`.gitignore`. The repository holds only source, documentation and the example file.

Nothing needs to be set up: the first `list` or `create` writes an empty
`label-requests.json` if none exists. `label-requests.example.json` is there to show the
file's shape and to give a feel for useful instructions; it is never read at runtime, and
deleting it changes nothing. Copy it over your store only if you want those examples as a
starting point.

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
"list my label requests".

**Personal skill (available in every project).** Link or copy the skill directory into
your personal skills directory:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/.claude/skills/inbox-labeler" ~/.claude/skills/inbox-labeler
```

A symlink keeps one copy, so `label-requests.json` stays in this repo. Copy the
directory instead if you would rather the store live outside the project. Restart
Claude Code after adding it.

Then say things like "add a label request for invoices", "list my label requests", or
"process my inbox with Inbox Labeler". Inbox processing uses Claude's Gmail tools when
they are connected; nothing runs on a schedule — you trigger it.

## How processing works

Inbox processing works on individual **messages**, not threads, and records both its state
and its outcome with the two system labels:

- a message is in scope when it is in the inbox, unread, and has no `IL/Processed`
- the complete result set is processed — pagination is followed until there is no next
  page, with no cap and no confirmation prompt for large runs
- every message goes through the full list of label requests, each one decided
  independently
- the result per message is the complete set of triggered label requests, and every one of
  their labels is applied

What happens then depends on whether anything triggered:

| Outcome | Labels applied |
| --- | --- |
| at least one label request triggered | every triggered business label, then `IL/Processed`; `IL/NoMatch` is removed if an earlier run left it there |
| nothing triggered | `IL/NoMatch`, then `IL/Processed` |

`IL/Processed` always goes on last, once every label request has been evaluated and the
outcome labels are in place — so an interrupted or failed run leaves the message to be picked
up again. `IL/NoMatch` is the only label Inbox Labeler ever removes, and only from a message
that has matches now.

Unread is only a scope filter: the unread state is never changed, and it is never used as
the processing state.

## Run it directly

From `.claude/skills/inbox-labeler/`:

```bash
python3 label_requests.py list
python3 label_requests.py create --name "Invoice" --label "IL/Invoice" \
  --instruction "The message is an invoice or bill for a purchase or service."
python3 label_requests.py update 8da8071c --instruction "The message is an invoice, bill or receipt."
python3 label_requests.py delete 8da8071c
```

`update` and `delete` take the stable `id` only — never the name. Use `list` to look up
the id belonging to a name. Every command prints JSON; on a validation failure it prints
`{"error": "..."}` and exits with status 1.

## Test it

There is no test framework — check the behaviour from the shell. Run it in a scratch copy so
your own store stays untouched:

```bash
mkdir -p /tmp/il-test && cp .claude/skills/inbox-labeler/label_requests.py /tmp/il-test/
cd /tmp/il-test

python3 label_requests.py list                                   # [] and creates the file

python3 label_requests.py create --name "Invoices" --label "IL/Invoices" --instruction "Invoices."
python3 label_requests.py create --name "News" --label "IL/News" --instruction "Newsletters."
python3 label_requests.py list                                   # both, each with an id

ID=$(python3 -c "import json;print(json.load(open('label-requests.json'))[1]['id'])")
python3 label_requests.py update "$ID" --label "IL/Newsletters"  # update by id
python3 label_requests.py delete "$ID"                           # delete by id

# each of these must print an error and exit 1
python3 label_requests.py create --name " "     --label "IL/X" --instruction "x"
python3 label_requests.py create --name "X"     --label "Work" --instruction "x"   # missing IL/
python3 label_requests.py create --name "X"     --label "IL/X" --instruction ""
python3 label_requests.py create --name "invoices" --label "IL/Dup" --instruction "x" # duplicate name
python3 label_requests.py delete Invoices                                          # name, not an id
python3 label_requests.py delete deadbeef                                          # unknown id
python3 label_requests.py update "$ID"                                            # nothing to update

# reserved system labels are rejected on create and on update, in any casing
python3 label_requests.py create --name "P" --label "IL/Processed" --instruction "x"
python3 label_requests.py create --name "N" --label "IL/NoMatch"   --instruction "x"
python3 label_requests.py create --name "P" --label "IL/processed" --instruction "x"
ID2=$(python3 -c "import json;print(json.load(open('label-requests.json'))[0]['id'])")
python3 label_requests.py update "$ID2" --label "IL/Processed"
python3 label_requests.py update "$ID2" --label "IL/NoMatch"

# labels that merely resemble the reserved ones are fine
python3 label_requests.py create --name "Q" --label "IL/Processing" --instruction "x"
python3 label_requests.py create --name "R" --label "IL/NoMatches"  --instruction "x"
```

## Scope

Deliberately small: local JSON storage, no database, no server, no auth, no scheduler,
no UI. Gmail work happens through Claude's Gmail tools as described in `SKILL.md`.
