---
name: inbox-labeler
description: Manage persistent Gmail label requests (name + IL/ label + matching instruction) and apply them to inbox emails on demand. Use when the user wants to create, change, delete or list label requests, or asks Inbox Labeler to process or reprocess / relabel their inbox.
---

# Inbox Labeler

Inbox Labeler keeps a list of **label requests**. Each one names the aspect of a message
it detects and the Gmail label to apply when that aspect is present:

| Field | Meaning |
| --- | --- |
| `id` | stable identifier, generated on create — the only handle for updates and deletes |
| `name` | short human name for the aspect, e.g. `Invoice` |
| `label` | **logical** label, stored without a prefix, e.g. `Invoice` — resolves to the Gmail label `IL/Invoice` |
| `instruction` | how you decide whether that aspect is present in a message, in natural language |

`label` holds the logical label only. `IL/` is Inbox Labeler's Gmail namespace — plumbing,
not part of a label's identity — so it never appears in stored configuration and is added
only when talking to Gmail: **the logical label `Invoice` resolves to the Gmail label
`IL/Invoice`.** Resolve in that direction every time you create a label, apply one, remove
one, compare one against a message's labels, or name one in output.

## What a label request is

> A user-defined way to detect an aspect of a message that is interesting to the user.

The aspect may be broad or narrow — that is entirely the user's choice, and both are equally
valid. A `Social` label request covering everything from a social platform is a good one; so
is `Connection` for connection requests alone; so is a user keeping both. The set of label
requests the user has defined *is* the model. Have no opinion about how fine-grained it
should be.

What the design does fix is how label requests behave together:

- **Independent.** Evaluate each label request on its own. Whether it triggers depends on
  two things only: the message, and its own instruction.
- **Any number may trigger.** A message triggers as many label requests as have their
  aspect present — none, one, several, or all of them.
- **Every trigger produces a label.** Each label request whose aspect is present
  contributes its label to the message.
- **Additive, not alternatives.** For a given message the outcome is the complete set of
  triggered label requests, and the labels applied are exactly that set.

Example: a LinkedIn connection request carries several aspects at once. It is social mail,
it is a connection request, and the user treats it as important. If the user keeps label
requests for all three aspects, the message carries `IL/Social`, `IL/Connection` and
`IL/Important` together.

## The `IL/` namespace

**Inbox Labeler owns the entire `IL/` namespace.** Every Gmail label whose name starts with
`IL/` is Inbox Labeler's to create, apply and remove — it is the whole of Inbox Labeler's
model, expressed as labels. The namespace is not a place for the user to keep labels of their
own: if they ask you to hand-create or hand-maintain one, explain that Inbox Labeler manages
that namespace and that the way to get a new `IL/` label is a label request.

Every kind of label Inbox Labeler works with lives inside it:

| Kind | Origin | Logical label | Gmail label |
| --- | --- | --- | --- |
| **business labels** | the `label` of a label request | `Invoice`, `Social` | `IL/Invoice`, `IL/Social` |
| **case labels** | future label kind, not part of this version | — | — |
| **bucket labels** | future label kind, not part of this version | — | — |
| **system labels** | Inbox Labeler's own state and outcome | `Processed`, `NoMatch` | `IL/Processed`, `IL/NoMatch` |

The two system labels:

| Gmail label | Meaning |
| --- | --- |
| `IL/Processed` | Inbox Labeler has finished evaluating this message. |
| `IL/NoMatch` | None of the current label requests matched this message. |

`IL/Processed` records **processing state** — that the work happened. `IL/NoMatch` records
the **outcome** of that work — that the evaluation produced no matches. They serve different
purposes and are applied independently of one another.

Because these two occupy `IL/Processed` and `IL/NoMatch`, the logical labels `Processed` and
`NoMatch` are reserved: the CLI rejects them on create and on update, case-insensitively. If a
user asks for one, explain that the name is taken by Inbox Labeler's own state and agree on a
different label.

**The boundary runs the other way too: Inbox Labeler never modifies a label outside `IL/`.**
Everything outside the namespace belongs to Gmail or to the user — `INBOX`, `UNREAD`,
`STARRED`, `IMPORTANT`, `CATEGORY_*`, and every label they made themselves. Read them freely
when they help a decision; never add or remove one.

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
  --label "Invoice" \
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

- Ask for anything missing rather than inventing it. A precise instruction describes the
  aspect being detected clearly enough to decide on a real message — at whatever breadth the
  user intends. Wording that sharpens that aspect belongs in the instruction ("invoices, but
  not payment reminders"); each request describes its own aspect and leaves the other
  requests to describe theirs.
- Take the aspect as the user frames it. If they describe something broad, keep it broad; if
  they describe several things they want as separate labels, create one request per label.
  The breadth is theirs to choose, so do not push toward finer or coarser requests.
- Configure the **logical** label, never the Gmail one. If the user says `IL/Invoices`, store
  `Invoices` — the CLI rejects anything starting with `IL/`, because it adds the namespace
  itself. Talk about labels the way the user does; just strip the prefix before it reaches
  `--label`.
- The logical labels `Processed` and `NoMatch` are reserved, since they resolve to Inbox
  Labeler's own `IL/Processed` and `IL/NoMatch`. The CLI rejects them on create and on update,
  in any casing. If a user asks for one, explain that Inbox Labeler uses it for its own state
  and agree on a different label rather than retrying.
- Before deleting, confirm which request is meant if the reference is ambiguous.
- After a successful change, report the resulting label request back to the user.

### Adding a label request to an existing set

When the user wants another aspect detected, create a label request for it. Existing requests
keep their instructions unchanged and the new one takes its place beside them — because
labelling is additive, adding a request never requires adjusting the others.

Requests that frequently land on the same mail while detecting different aspects are each
doing their own job, and both belong in the list. Two requests are the same request only when
they detect the same aspect — the same purpose and essentially the same instruction.

Names are unique (case-insensitive), so a create can fail on a name collision. That is a
naming clash about the `name` field alone: offer a different name, or ask whether the
existing request should be updated instead.

## Processing the inbox

Only do this when the user explicitly asks. There is no scheduler and nothing runs in the
background. Two commands exist:

| The user says | Command | Scope |
| --- | --- | --- |
| "process my inbox" | **process** | unread inbox messages **without** `IL/Processed` — new mail only |
| "reprocess my inbox" | **reprocess** | **every** unread inbox message, including those already processed |

`process` is the everyday run: it looks at mail Inbox Labeler has not seen yet and leaves
already-processed messages alone. `reprocess` re-evaluates everything against the current set
of label requests and replaces each message's previous outcome — that is what makes it the
right choice after label requests were added, changed, or deleted. Follow the flow that
matches what the user asked for, and if the wording is genuinely ambiguous, ask which one they
mean rather than guessing: `reprocess` rewrites labels that `process` would leave untouched.

Both commands share the same fundamentals. A **message** is the unit of work — never a
thread. Only unread inbox messages are ever touched, so archived mail and read mail are out of
scope in both commands. `IL/Processed` records that a message was evaluated and `IL/NoMatch`
records that the evaluation produced no matches. Unread is only a scope filter — **never
change the unread state** (no marking as read) and never treat unread as the processing state.

### process

1. Run `python3 label_requests.py list`. If it is empty, say so and stop. Resolve each
   request's logical label to its Gmail name — `Invoice` → `IL/Invoice` — and work with the
   resolved names from here on; Gmail knows nothing about logical labels.
2. Run `list_labels` and note the ids of `IL/Processed`, `IL/NoMatch` and every resolved
   request label. Create any that are missing with `create_label`, passing the resolved name
   (the `IL` parent is created automatically).
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
6. For each in-scope message, work through the whole list of label requests and decide each
   one independently, keeping the ones whose aspect is present. Subject, sender and snippet
   are usually enough; use the full body from `get_thread` when they are not. The result is
   the complete set of triggered label requests — empty, one, several, or all.
7. Apply the outcome with `label_message`, which branch depending on whether the set is
   empty:
   - **At least one label request triggered** — apply the resolved business label of every
     triggered request, then `IL/Processed`. If the message still carries `IL/NoMatch` from an
     earlier run, remove it with `unlabel_message`: the message has matches now, so that
     outcome no longer holds.
   - **No label request triggered** — apply `IL/NoMatch`, then `IL/Processed`.
   In both branches `IL/Processed` goes on last, once the message has been evaluated against
   every label request and its outcome labels have been applied. If evaluation is incomplete
   or a labelling call fails, leave `IL/Processed` off so the message is picked up again on
   the next run.
8. Report a short summary: how many messages were processed, which message got which business
   labels and why, which got `IL/NoMatch`, and anything you were unsure about instead of
   guessing silently.

### reprocess

Use this when the user asks to reprocess, or to re-run the labels after changing label
requests. The governing idea:

> **Reprocess behaves as if Inbox Labeler had never seen the message before.**

Because Inbox Labeler owns the whole `IL/` namespace, achieving that needs no bookkeeping:
strip every `IL/` label off the message, then label it from scratch. There is no need to work
out which labels came from which label request, or which requests have since been changed or
deleted — anything in the namespace is Inbox Labeler's previous answer, and the previous answer
is being discarded.

1. Run `python3 label_requests.py list`. If it is empty, say so and stop — with no label
   requests there is nothing to re-evaluate against. Resolve each logical label to its Gmail
   name as in `process` step 1.
2. Run `list_labels` and build the id map for the whole namespace: **every** label whose name
   starts with `IL/`, not just the ones you expect. Create any label a current request needs,
   plus `IL/Processed` and `IL/NoMatch`, with `create_label`.
3. Find candidate threads with `search_threads`, query `in:inbox is:unread`, `pageSize: 50`.
   There is deliberately no `-label:` filter: messages that already carry `IL/Processed` are
   included this time.
4. **Follow pagination to the end**, exactly as in `process` — keep calling `search_threads`
   with the returned `nextPageToken` until no next page token comes back, and handle the
   complete result set.
5. For each thread, call `get_thread` and pick out the messages that are in the inbox and
   unread. `IL/Processed` is not a disqualifier here, but read messages and messages outside
   the inbox still are, so check `labelIds` per message.
6. **Clear the namespace on that message.** Intersect its `labelIds` with the `IL/` ids from
   step 2 and remove all of them in **one** `unlabel_message` call. Every label outside the
   namespace is preserved untouched — Gmail's own labels and anything the user made stay
   exactly as they are. (`labelIds` holds ids, not names, which is why step 2 maps the whole
   namespace: an id you cannot resolve to an `IL/` name is not yours to remove.)
7. Evaluate the message against every current label request independently, the same way as
   `process` step 6. The message now carries no `IL/` labels at all, so judge it purely on its
   own content — this is a first look, not a review of an earlier decision.
8. Apply the new business labels with `label_message`: the resolved label of every triggered
   request.
9. Apply any matching **case labels**, then the resulting **bucket label**. Neither kind exists
   in this version, so today these steps are no-ops — when they are introduced they slot in
   here, and step 6 already clears them for free because they live in the namespace.
10. If no business label matched, apply `IL/NoMatch`.
11. Apply `IL/Processed` last, once evaluation finished and every outcome label is in place.
12. Report a summary: how many messages were re-evaluated, what changed (labels gained, labels
    lost, `IL/NoMatch` set or cleared), what stayed the same, and any message you could not
    complete.

The outcome fully replaces the previous one, so a message that no longer matches `IL/Social`
loses it, a message that was `IL/NoMatch` and now matches `IL/Birthday` ends up with
`IL/Birthday` alone, a label whose request was deleted disappears, and a message whose matches
are unchanged ends up exactly as it was.

Failure handling is per message. If a call fails partway through a message, leave
`IL/Processed` off that message, report it, and carry on with the remaining messages — one
failure never aborts the run. A message left stripped and without `IL/Processed` is in a safe
state: the next `process` run picks it up again, because that is precisely its scope.

Rules for both commands:

- **Resolve logical labels once, then stay in Gmail terms.** Every Gmail call and every
  comparison against a message's `labelIds` uses the resolved `IL/…` name, and processing
  output names labels the way the user sees them in Gmail — report `IL/Invoice`, not `Invoice`.
  Logical labels belong to configuration; only the CLI deals in them.
- **Every message goes through the full list.** Each label request gets its own decision for
  that message, and each one that triggers contributes its label. A message that triggers six
  requests gets six labels; how many labels a message ends up with is simply how many of the
  user's label requests found their aspect in it.
- **`IL/NoMatch` and business labels never coexist.** A processed message carries either at
  least one business label or `IL/NoMatch`, never both — the outcome is one or the other.
- **`IL/Processed` is always last and always earned.** Never leave it on a message whose
  evaluation did not complete successfully, in either command.
- **Removal is confined to the `IL/` namespace.** Inside it, anything may be removed —
  `reprocess` clears all of it, `process` drops a stale `IL/NoMatch`. Outside it, nothing is
  ever added or removed: Gmail's own labels (`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`,
  `CATEGORY_*`) and every user label are read-only. Never archive, mark as read, delete, or
  reply — labelling is the entire job.
- Work through the entire result set, however large, and label each message with everything
  it triggered. Neither a long list of messages nor a long list of labels on one message
  calls for stopping, sampling, or asking for confirmation.
- One failing message is not a failing run: report it and continue with the rest.
- If Gmail tools are unavailable, do not fake it: report which messages you cannot reach and
  present the labelling decisions as a plan, applying nothing.
