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

They are stored in `label-requests.json` in this skill's directory. The file is local,
untracked, and created automatically on first use — an empty list is a normal starting
state, not an error. Never edit it by hand: always go through the CLI below, which
validates before writing. (`label-requests.example.json` is documentation only — never
read from or write to it.)

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

A **message** is the unit of work — never a thread. A message is in scope when it is
all three of: in the inbox, unread, and without `IL/Processed`.

`IL/Processed` is the processing state: a message carries it once Inbox Labeler has
finished evaluating it. Unread is only a scope filter — **never change the unread state**
(no marking as read) and never treat unread as the processing state.

1. Run `python3 label_requests.py list`. If it is empty, say so and stop.
2. Run `list_labels` and note the ids of `IL/Processed` and of every request's label.
   Create any that are missing with `create_label` (the `IL` parent is created automatically).
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
6. For each in-scope message, evaluate **every** label request against it. Subject, sender
   and snippet are usually enough; use the full body from `get_thread` when they are not.
   A message may match several requests, or none.
7. Apply the outcome with `label_message` — all matching request labels, then `IL/Processed`
   last. Add `IL/Processed` only after the message has been evaluated against every request
   and its matching labels applied; if evaluation is incomplete or a labelling call fails,
   leave it off so the message is picked up again on the next run.
8. Report a short summary: how many messages were processed, which message got which label
   and why, which matched nothing (but are now processed), and anything you were unsure
   about instead of guessing silently.

Rules while processing:

- Only ever add `IL/` labels. Do not remove labels, archive, mark as read, delete, or
  reply — labelling is the entire job.
- Do not stop, sample, or ask for confirmation because the result set is large. Work
  through all of it.
- If Gmail tools are unavailable, do not fake it: report which messages you cannot reach and
  present the labelling decisions as a plan, applying nothing.
