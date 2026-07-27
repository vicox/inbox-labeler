# Inbox Labeler (local prototype)

A Claude Agent Skill for keeping persistent **label requests** and applying them to
Gmail inbox mail on demand.

A label request answers three things: what it is called, which Gmail label to apply,
and how Claude should decide whether an email matches.

```json
{
  "id": "8da8071c",
  "name": "Invoices",
  "label": "IL/Invoices",
  "instruction": "Emails containing an invoice, receipt or payment confirmation."
}
```

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
- every label request is evaluated against every in-scope message
- all matching labels are applied
- `IL/Processed` is applied last, only after evaluation against all requests succeeded — so
  an interrupted or failed run leaves the message to be picked up again

Unread is only a scope filter: the unread state is never changed, and it is never used as
the processing state.

## Run it directly

From `.claude/skills/inbox-labeler/`:

```bash
python3 label_requests.py list
python3 label_requests.py create --name "Invoices" --label "IL/Invoices" \
  --instruction "Emails containing an invoice, receipt or payment confirmation."
python3 label_requests.py update 8da8071c --instruction "Invoices and receipts only."
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
