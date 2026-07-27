---
name: inbox-labeler
description: Manage persistent Gmail label requests (name + IL/ label + matching instruction) and apply them to inbox emails on demand. Use when the user wants to create, change, delete or list label requests, or asks Inbox Labeler to process / label their inbox.
---

# Inbox Labeler

Inbox Labeler keeps a list of **label requests**. Each one names the aspect of a message
it detects and the Gmail label that shows the answer:

| Field | Meaning |
| --- | --- |
| `id` | stable identifier, generated on create — the only handle for updates and deletes |
| `name` | short human name for the aspect, e.g. `Invoices` |
| `label` | Gmail label applied when the aspect is present, always inside the `IL/` namespace, e.g. `IL/Invoices` |
| `instruction` | the one question you answer about a message, in natural language |

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

Example: a LinkedIn connection request carries several aspects at once. It is social mail,
it is a connection request, and the user treats it as important. Three label requests ask
those three questions, all three answer yes, so the message carries `IL/Social`,
`IL/Connection` and `IL/Important`.

When another aspect of a message is worth seeing, that is a new label request — each one
stays focused on the single question it was created to answer.

## Storage

Label requests are stored in `label-requests.json` in this skill's directory. The file is
local, untracked, and created automatically on first use — an empty list is a normal
starting state, not an error. Never edit it by hand: always go through the CLI below, which
validates before writing. (`label-requests.example.json` is documentation only — never
read from or write to it.)

## Managing label requests

Run these from this skill's directory:

```bash
# list_label_requests
python3 label_requests.py list

# create_label_request
python3 label_requests.py create \
  --name "Invoice" \
  --label "IL/Invoice" \
  --instruction "The message is an invoice or bill for a purchase or service."

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

- Ask for anything missing rather than inventing it. A precise instruction names the one
  aspect being detected, so the request has a clear question to answer. Wording that
  sharpens that one aspect belongs in the instruction ("invoices, but not payment
  reminders"). Each request describes its own aspect and leaves the other requests to
  describe theirs.
- Give each new request a single question to answer. When the user describes two aspects in
  one breath, offer to create two label requests, one per aspect.
- If the user gives a label without the `IL/` prefix, prepend it (`Invoices` → `IL/Invoices`).
  The CLI rejects labels outside that namespace.
- Before deleting, confirm which request is meant if the reference is ambiguous.
- After a successful change, report the resulting label request back to the user.

### Many small label requests

Aim for a collection of small, focused label requests rather than a few large ones. Each
one detects a single aspect, so aspects that often appear together still get their own
request:

- `IL/Invoice` — the message is an invoice
- `IL/Stripe` — the message comes from Stripe
- `IL/Reminder` — the message is a reminder about something due

A Stripe invoice reminder triggers all three and carries all three labels. That is the
design working as intended: three questions, three independent answers, three labels.

So when the user wants a new aspect detected, create a new label request for it. Existing
requests keep their own question unchanged, and the new one adds its own answer alongside
them. Two requests are the same request only when they ask the same question — the same
purpose and essentially the same instruction. Requests that frequently land on the same mail
while detecting different aspects are each doing their own job, and both belong in the list.

Names are unique (case-insensitive), so a create can fail on a name collision. That is a
naming clash about the `name` field alone: offer a different name, or ask whether the
existing request should be updated instead.

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
6. For each in-scope message, work through the whole list of label requests and answer each
   one's question independently, keeping the ones that answer yes. Subject, sender and
   snippet are usually enough; use the full body from `get_thread` when they are not. The
   result is the complete set of triggered label requests — empty, one, several, or all.
7. Apply that set with `label_message`: the label of every triggered request, then
   `IL/Processed` last. Add `IL/Processed` once the message has been evaluated against every
   label request and every triggered label has been applied; if evaluation is incomplete or a
   labelling call fails, leave it off so the message is picked up again on the next run.
8. Report a short summary: how many messages were processed, which message got which labels
   and why, which triggered nothing (and are now processed), and anything you were unsure
   about instead of guessing silently.

Rules while processing:

- **Every message goes through the full list.** Each label request gets its own answer for
  that message, and each yes contributes its label. A message that triggers six requests
  gets six labels; the count of labels a message ends up with is simply the number of
  aspects it has.
- Only ever add `IL/` labels. Do not remove labels, archive, mark as read, delete, or
  reply — labelling is the entire job.
- Work through the entire result set, however large, and label each message with everything
  it triggered. Neither a long list of messages nor a long list of labels on one message
  calls for stopping, sampling, or asking for confirmation.
- If Gmail tools are unavailable, do not fake it: report which messages you cannot reach and
  present the labelling decisions as a plan, applying nothing.
