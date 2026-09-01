---
name: inbox-labeler-attention
description: Apply Inbox Labeler Attention behavior to already processed unread inbox emails. Uses existing IL/* labels to star high-attention mail or mark none-attention mail read after 24 hours without reclassifying messages.
---

# Inbox Labeler — attention

One job: bring Gmail's own state in line with the attention the labels **already on a message**
imply. It **does not classify anything** and it **never adds or removes an `IL/` label** —
`inbox-labeler-process` owns labelling, this owns the Gmail state that follows from it.

**Run this only when the user asks for it.** It stars mail and it marks mail read, so it is never
automatic: it is not part of a processing run, it does not follow one, and a processing run must
never chain into it on its own initiative. After mail has been processed, say that attention is
available and wait to be asked.

**Two connections do different things.** Inbox Labeler's MCP server holds the labels and has no
access to the mailbox; Gmail holds the mail. `get_labels` is the MCP's; `list_labels`,
`search_threads`, `get_thread`, `label_message` and `unlabel_message` are Gmail's. Identity is
the authenticated MCP session — never ask the user for an account id and never pass one to any
tool.

## Scope

Only **unread inbox messages that carry `IL/processed`**. This is the mirror image of
processing: `process` classifies mail that has no `IL/processed`, this acts on mail that has it.
The two never overlap, and archived mail and read mail are out of scope for both.

## Attention

**Attention is not a label.** It is what a label asks of the user, declared per label and
computed per message. It is never written to Gmail and never stored on a message.

| Level | What the label is saying |
| --- | --- |
| `none` | the user never needs to see this |
| `normal` | *(the default)* leave the message alone |
| `high` | important, and stays important |

**The highest-priority level among the labels a message carries wins**, ranked `high` > `none` >
`normal`:

- one label at `high` → `high`
- otherwise, one label at `none` → `none`
- otherwise → `normal`

`normal` loses to both because it is the *absence* of a request — the default a label gets when
nothing was said about it. A label that does ask for something outranks it, and asking for
attention outranks asking for none. So `Invoice` (`normal`) together with `Newsletter` (`none`)
comes out `none`: the one label with an opinion is the one that has it. A message with no labels
at all comes out `normal`, so it is left alone.

Apply the ranking exactly as written and never rank the levels by eye: `Invoice` (`normal`) with
`Delivery arriving soon` (`high`) is `high`; `Invoice` (`normal`) with `Newsletter` (`none`) is
`none`. A label that `get_labels` does not have takes no part in the calculation — leave it out
entirely and never guess its Attention.

The behaviours are fixed, not configurable:

| Attention | Behaviour | Effect |
| --- | --- | --- |
| `none` | `mark_read` | mark read once the message is 24h old, otherwise nothing |
| `normal` | — | nothing |
| `high` | `star` | star it, and keep it starred |

Ages count from **when the message was received**, which is the only timestamp available. The
24h threshold is inclusive — exactly 24h qualifies.

## Step zero: make sure labels are available

Without labels there is no attention to apply.

1. **Call `get_labels`.** That is the store; there is nothing local and nothing to load first.
2. **It returns labels.** Continue with the flow below. These are the labels this run uses —
   never a remembered set, never an earlier run's.
3. **It returns an empty list.** **Stop**, and change no message.
4. **The call fails** — the MCP server is unreachable, the session is not authenticated, or the
   call errors. **Report the error verbatim and stop**, and change no message. Do not fall back
   to an empty list and do not guess at labels.

## The run

1. Complete [step zero](#step-zero-make-sure-labels-are-available).
2. Run `list_labels` and note the id of `IL/processed` and of every label's resolved Gmail name.
   Create nothing here — a label that does not exist in Gmail cannot be on a message.
3. Find candidate threads with `search_threads`, query
   `in:inbox is:unread label:<IL/processed id>`. This is the mirror image of `process`: only
   mail that **has** been processed.
4. For each thread, call `get_thread` and pick out the messages that are in the inbox, unread
   and carry `IL/processed`. Gmail returns a whole thread when any one of its messages matches,
   so check every message and skip the ones that do not qualify.
5. **Read the labels already on the message.** Take its `labelIds`, keep the ones that resolve
   to an `IL/` name, and strip the prefix to get the labels. Ignore `IL/processed` and
   `IL/no-match` — they are state, not meaning. Do not evaluate the email, do not consult its
   content, and do not reconsider whether a label belongs there.
6. Work out the effective level over those labels with the ranking in
   [Attention](#attention). A label that `get_labels` no longer has takes no part in the
   calculation — leave it out, and name any you found in the report.
7. Read the behaviour for that level from the table in [Attention](#attention), against the age of
   the message, and carry out what it says:
   - `star` → `label_message` with `STARRED`
   - `mark_read` → `unlabel_message` with `UNREAD`
   - nothing → leave the message untouched

   `STARRED` and `UNREAD` are the only two things this run writes, and it uses those tools for
   nothing else. Skip an action whose state already holds — do not re-star a starred message,
   and do not clear `UNREAD` on a message that is already read.
8. Report what changed per message, what was left alone, and any `IL/` labels you found that
   `get_labels` no longer has.

## Boundaries this run must not cross

- **It never classifies.** It does not read the email's content, does not evaluate any label's
  `instruction`, and does not reconsider whether a label belongs on a message. The labels
  already on the message are the whole input.
- **It never touches an `IL/` label, in either direction** — no adding, no removing, not even
  `IL/processed`.
- **It never calls `record_matches`.** Recording belongs to processing.
- **It never archives, deletes or replies**, and it writes nothing to Gmail beyond `STARRED` and
  `UNREAD`.
- **It never touches mail without `IL/processed`**, mail outside the inbox, or mail that is
  already read.
- If a Gmail action is unavailable, report that limitation and leave the message alone; never
  substitute a different action.
- One failing message is not a failing run: report it and continue with the rest.
