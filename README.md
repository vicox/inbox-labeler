# Inbox Labeler (local prototype)

A Claude Agent Skill for keeping persistent **label requests** and applying them to
Gmail inbox mail on demand.

A label request names one aspect of a message, the question that detects it, and the Gmail
label that shows the answer.

```json
{
  "id": "8da8071c",
  "name": "Invoice",
  "label": "IL/Invoice",
  "instruction": "The message is an invoice or bill for a purchase or service."
}
```

## One job per label request

A label request has exactly one job:

> **Detect one specific aspect of a message.**

It asks exactly one question about the message, and its Gmail label is the visible answer.
This is the central design principle of Inbox Labeler:

- **One responsibility each.** One label request, one aspect, one question, one label.
- **Independent evaluation.** Each label request is evaluated on its own. Its answer
  depends on two things only: the message, and its own instruction.
- **Every trigger produces a label.** Each label request whose aspect is present
  contributes its label to the message.
- **Any number may trigger.** A message triggers as many label requests as have their
  aspect present — none, one, several, or all of them.
- **The result is a set.** For a given message the outcome is the complete set of triggered
  label requests, and the labels applied are exactly that set.

A LinkedIn connection request, for example, carries several aspects at once: it is social
mail, it is a connection request, and you treat it as important. Three label requests ask
those three questions, all three answer yes, so the message carries `IL/Social`,
`IL/Connection` and `IL/Important`.

## Keep label requests small

Aim for many small, focused label requests rather than a few large ones. When you want
another aspect detected, add a label request for it instead of making an existing one carry
more meaning. Prefer three sharp questions:

- `IL/Invoice` — the message is an invoice
- `IL/Stripe` — the message comes from Stripe
- `IL/Reminder` — the message is a reminder about something due

over one request trying to encode all three concerns. A Stripe invoice reminder then
triggers all three and carries all three labels, and each label stays meaningful on its own:
`IL/Stripe` still finds everything from Stripe, whether or not it is an invoice.

Aspects that usually appear together still deserve separate requests — each one answers its
own question, and each adds its own label. Two requests are the same request only when they
ask the same question, i.e. the same purpose and essentially the same instruction.

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

## Processing state

Inbox processing works on individual **messages**, not threads, and tracks its own state
with the Gmail label `IL/Processed`:

- a message is in scope when it is in the inbox, unread, and has no `IL/Processed`
- the complete result set is processed — pagination is followed until there is no next
  page, with no cap and no confirmation prompt for large runs
- every message goes through the full list of label requests, each one answered
  independently
- the result per message is the complete set of triggered label requests, and every one of
  their labels is applied
- `IL/Processed` is applied last, once every label request has been evaluated and every
  triggered label applied — so an interrupted or failed run leaves the message to be picked
  up again

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

There is no test framework — check the behaviour from the shell:

```bash
cd .claude/skills/inbox-labeler

# starts from a clean store
rm -f label-requests.json
python3 label_requests.py list                                   # [] and recreates the file

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
```

## Scope

Deliberately small: local JSON storage, no database, no server, no auth, no scheduler,
no UI. Gmail work happens through Claude's Gmail tools as described in `SKILL.md`.
