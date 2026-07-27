---
name: inbox-labeler
description: Manage persistent Gmail label requests (name + IL/ label + matching instruction) and apply them to inbox emails on demand. Use when the user wants to create, change, delete or list label requests, or asks Inbox Labeler to process / label their inbox.
---

# Inbox Labeler

Inbox Labeler keeps a list of **label requests**. Each one says which Gmail label to
apply and how to decide whether an email matches:

| Field | Meaning |
| --- | --- |
| `id` | stable identifier, generated on create — the only handle for updates and deletes |
| `name` | short human name, e.g. `Invoices` |
| `label` | Gmail label to apply, always inside the `IL/` namespace, e.g. `IL/Invoices` |
| `instruction` | natural-language rule you evaluate against an email |

They are stored in `label-requests.json` in this skill's directory. Never edit that
file by hand — always go through the CLI below, which validates before writing.

## Managing label requests

Run these from this skill's directory:

```bash
# list_label_requests
python3 label_requests.py list

# create_label_request
python3 label_requests.py create \
  --name "Invoices" \
  --label "IL/Invoices" \
  --instruction "Emails containing an invoice, receipt or payment confirmation."

# update_label_request — pass only the fields that change
python3 label_requests.py update 8da8071c --instruction "Invoices and receipts, but not payment reminders."

# delete_label_request
python3 label_requests.py delete 8da8071c
```

`update` and `delete` take the `id` only. When the user refers to a request by name, run
`list` first, match the name yourself, and use the `id` you found. If no name matches, or
several plausibly do, ask instead of guessing.

Every command prints JSON; on failure it prints `{"error": "..."}` and exits non-zero.

Guidance:

- Ask for anything missing rather than inventing it. A vague instruction produces bad
  labelling, so make sure it states what should match and, where useful, what should not.
- If the user gives a label without the `IL/` prefix, prepend it (`Invoices` → `IL/Invoices`).
  The CLI rejects labels outside that namespace.
- Names are unique (case-insensitive). If one is taken, ask whether to update the existing
  request instead of creating a second one.
- Before deleting, confirm which request is meant if the reference is ambiguous.
- After a successful change, report the resulting label request back to the user.

## Processing the inbox

Only do this when the user explicitly asks (e.g. "process my inbox", "run Inbox
Labeler"). There is no scheduler and nothing runs in the background.

`IL/Processed` is the processing state: a message carries it once Inbox Labeler has
finished evaluating it. **Read/unread status is never the processing state** — do not
filter on `is:unread`, and do not change read status.

1. Run `python3 label_requests.py list`. If it is empty, say so and stop.
2. Run `list_labels` and note the ids of `IL/Processed` and of every request's label.
   Create any that are missing with `create_label` (the `IL` parent is created automatically).
3. Find candidate threads with `search_threads`, query `in:inbox -label:<IL/Processed id>`
   — pass the label *id*, not the display name. If you just created `IL/Processed`,
   `in:inbox` is equivalent. Default to the most recent 20 threads unless the user asks for
   a different scope (e.g. "everything from today" → add `newer_than:1d`).
4. For each thread, call `get_thread` and process the messages whose `labelIds` do not
   already contain the `IL/Processed` id. A returned thread can mix processed and
   unprocessed messages, so check per message and skip the ones already done.
5. For each unprocessed message, evaluate **every** label request against it. Subject,
   sender and snippet are usually enough; use the full body from `get_thread` when they are
   not. A message may match several requests, or none.
6. Apply the outcome with `label_message`: all matching request labels, plus `IL/Processed`.
   Add `IL/Processed` only after the message has been evaluated against every request — if
   evaluation is incomplete or a labelling call fails, leave it off so the message is picked
   up again on the next run.
7. Report a short summary: which message got which label and why, which matched nothing
   (but are now processed), and anything you were unsure about instead of guessing silently.

Rules while processing:

- Only ever add `IL/` labels. Do not remove labels, archive, mark as read, delete, or
  reply — labelling is the entire job.
- If more than ~20 messages would be labelled, show the plan and ask for confirmation first.
- If Gmail tools are unavailable, do not fake it: report which threads you cannot reach and
  present the labelling decisions as a plan, applying nothing.
