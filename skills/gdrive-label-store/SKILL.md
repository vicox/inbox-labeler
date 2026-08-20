---
name: gdrive-label-store
description: Load and save the Inbox Labeler's state — its label definitions in labels.json and its match statistics in matches.json — in the Google Drive folder "Inbox Labeler". The canonical version of each is the most recently modified one there. Use when the user wants to fetch labels or match history from Drive, check them, or write changes back. Not a general Google Drive integration and not involved in email processing.
---

# Google Drive Label Store

The Inbox Labeler's state lives in Google Drive:

```text
Inbox Labeler/
    labels.json          ← the most recently modified one is canonical
    matches.json         ← the same, and optional
```

The folder is the product workspace, so **always locate the folder first, then the files inside
it** — never search Drive-wide for `labels.json` or `matches.json`.

| File | | Holds |
| --- | --- | --- |
| `labels.json` | **required** | the policy: every label, its type, its instruction, its attention |
| `matches.json` | **optional** | how often each label has matched: a label, a day, a count |

**`matches.json` may simply not exist**, in Drive or locally, and that is a normal state rather
than a fault. A mailbox that has never been processed has no history, and someone who has used
the Inbox Labeler since before there were counts has none either. Neither operation below
treats its absence as a failure.

`matches.json` holds **counts, never mail**: per label the newest email timestamp seen and a
number per calendar day. No subject, no sender, no recipients, no message or thread id, nothing
about an attachment. This skill neither needs nor adds any of that, and validation rejects a
document that carries it.

This skill loads that state and saves it back. It does nothing else: no Gmail, no email
processing, no label interpretation. Those belong to the `inbox-labeler` skill.

The two operations are not symmetric about the workspace folder, on purpose:

| | If `Inbox Labeler` is missing |
| --- | --- |
| **load** | report that no label definitions were found, and **create nothing** |
| **save** | **create the folder** and carry on, without asking |

A load is read-only: it either finds something to read or says there is nothing. A save has
something to write and is allowed to make room for it.

## Newest wins

Saving creates a **new** `labels.json` in the folder. Earlier ones stay where they are, and
that is deliberate:

- **Loading** takes the `labels.json` with the newest `modifiedTime`. That one is canonical.
- **Saving** adds another one, which by definition becomes the newest, and therefore canonical.
- **Nothing is replaced or deleted.** Superseded versions simply stop being loaded.

Two consequences worth knowing. The folder accumulates a version per save, and removing old
ones is a manual job in the Drive UI — the connector has no delete tool. In exchange, a save
can never destroy someone else's work: if two people save from different copies, both files
exist and the later one is canonical, so nothing is lost and no conflict handling is needed.

## The two halves of this skill

| Half | Where it lives | Nature |
| --- | --- | --- |
| Drive I/O — find, download, upload | the Drive connector's tools | you call them |
| Validation and serialisation | `label_store.py` | deterministic, tested |

**Never validate by eye and never hand-write the JSON.** `label_store.py` reports *every*
problem in a document rather than the first, and it never repairs anything silently.

```bash
python3 label_store.py validate FILE                    # every error, exit 1 if any
python3 label_store.py format   FILE [--write]          # stable, human-readable JSON
python3 label_store.py validate FILE --kind matches     # the same, for matches.json
python3 label_store.py format   FILE --kind matches
```

`--kind` defaults to `labels`. Pass `--kind matches` for a matches document — the two have
different shapes, and checking one against the other's schema reports nonsense.

## Load labels

**Loading never writes anything.** It reads, or it reports that there is nothing to read.

1. **Find the workspace folder.** `search_files` with:
   ```text
   title = 'Inbox Labeler' and mimeType = 'application/vnd.google-apps.folder'
   ```
   Empty result → stop and report: *no label definitions were found — the workspace folder
   "Inbox Labeler" does not exist in Drive.* **Do not create it**, even though saving would, and
   do not fall back to another folder. More than one match → stop and ask which one; guessing
   risks reading the wrong workspace.
2. **Find every `labels.json` in it.** `search_files` with:
   ```text
   parentId = '<folder id>' and title = 'labels.json'
   ```
   Paginate to the end — with a version per save there may be more than one page.
   - **None** → report: *no label definitions found in the "Inbox Labeler" folder.* Stop.
   - **One** → that is the canonical file.
   - **Several** → the one with the newest `modifiedTime` is canonical. Say how many older
     versions you ignored, so the accumulation stays visible.
3. **Download it.** `download_file_content` on that file id. It returns base64; decode it to a
   local working copy. `read_file_content` is the wrong tool here — it returns a
   natural-language rendering and does not support `application/json`.
4. **Validate before returning anything.**
   ```bash
   python3 label_store.py validate /tmp/labels-work/labels.json
   ```
   Non-zero exit → report the errors and **return no labels at all**. An invalid document is
   not a partial success; the Inbox Labeler must never run against one.

5. **Then load the match history**, the same way and in the same folder: `search_files` with
   `parentId = '<folder id>' and title = 'matches.json'`, newest `modifiedTime` wins,
   `download_file_content`, and validate it with
   `python3 label_store.py validate /tmp/labels-work/matches.json --kind matches`.
   - **None in the folder** → report *no match history stored yet* and **change nothing
     locally**. This is not an error and not a warning: there is simply nothing to apply, so a
     local `data/matches.json` stays exactly as it is.
   - **One or several** → the newest is canonical. Write it to `data/matches.json`, replacing
     what is there.
   - **Invalid** → report the errors and leave `data/matches.json` untouched. A broken history
     is not worth a good one.

   A failure here does not undo the labels: say that the definitions loaded and the history did
   not, and which errors stopped it.

The local copy is scratch. Drive holds the truth, so never leave a change only in the copy.

**A load replaces the local files it found remotely**, definitions and history alike — that is
what "Drive holds the truth" means, and it is the same rule for both. For counts it is worth
saying out loud: matches recorded since the last save are **lost** when a newer history comes
down from Drive. Save before loading if a run has happened in between, or accept the older
counts. Nothing merges the two, and nothing here guesses which one the user wanted.

## Save labels

**Saving creates the workspace when it has to.** That is the one asymmetry with loading, and it
is deliberate: a load has nothing to read and says so, while a save has something to write and
needs somewhere to put it.

1. **Validate.** A document that fails validation is never uploaded.
2. **Serialise stably**, so a diff between versions shows the real change and nothing else:
   ```bash
   python3 label_store.py format /tmp/labels-work/labels.json --write
   ```
3. **Find the workspace folder**, with the same query the load uses.
   - **It exists** → use it, and add to it. Never create a second folder of the same name.
   - **It does not exist** → **create it, without asking.** `create_file` with
     `title` = `Inbox Labeler` and `contentMimeType` =
     `application/vnd.google-apps.folder`, and no `parentId`, which puts it in My Drive. Say
     that you created it in the report; do not turn it into a question.
   - **Several exist** → stop and ask which one. Creating is unambiguous, choosing between
     existing workspaces is not.
4. **Create a new file** in that folder with `create_file`:
   - `parentId` — the folder id
   - `title` — `labels.json`
   - `contentMimeType` — `application/json`
   - `disableConversionToGoogleType` — `true`, or Drive turns it into a Google Doc
   - `textContent` — the serialised document
5. **Report** the new file id, whether the folder had to be created, and how many `labels.json`
   files the folder now holds.

6. **Then save the match history, if there is one.** If `data/matches.json` does not exist,
   there is nothing to save: say *no match history to save yet* and treat the save as complete.
   **Never invent an empty one to have something to upload** — an empty history and no history
   read the same on the way back down, and a fabricated file makes the folder look like it holds
   something it does not.

   If it does exist, validate it with `--kind matches`, serialise it with
   `format --kind matches --write`, and `create_file` it into the same folder with
   `title` = `matches.json` and the same options as step 4.

7. **Report each file separately.** Say which ones were written, with their new file ids, and
   name any that were not and why. Definitions come first and matter most: if `labels.json`
   fails to validate or to upload, stop and report that — do not go on to the history. If the
   definitions were saved and the history was not, **say exactly that**; a save that got half
   way is not a save that worked, and reporting it as one leaves the user believing their
   counts are in Drive when they are not.

Do not try to replace or delete the previous version of either file. There is no
update-in-place and no delete tool, and the newest file is canonical anyway.

## Validate labels

Everything checked, on every load and before every save:

| Check | Rejected example |
| --- | --- |
| valid JSON | a truncated file |
| root is an array of objects | `{"labels": []}` |
| required properties present | a label with no `instruction` |
| field types correct | `"instruction": 42`, `"required_labels": "A"` |
| no unknown properties | `"colour": "red"` |
| labels unique, ignoring case | `Invoice` and `invoice` |
| labels trimmed, no doubled spaces | `" Padded "`, `"Two  spaces"` |
| reserved names refused | `processed`, `no-match` |
| no `IL/` prefix stored | `IL/Invoice` |
| references resolve | `required_labels: ["Ghost"]` |
| references point at detection labels | a derived label referencing a derived label |
| no circular dependencies | `A → B → A`, or `A → A` |

And for a matches document, with `--kind matches`:

| Check | Rejected example |
| --- | --- |
| valid JSON | a truncated file |
| root is an object keyed by label | `[{"label": "Invoice"}]` |
| labels trimmed, unique ignoring case, no `IL/` prefix | `"IL/Invoice"`, `" Padded "` |
| reserved names refused | `processed`, `no-match` |
| **no property but a last timestamp and a count per day** | `"subject": "..."`, `"message_id": "..."` |
| `last_matched_at` is null or ISO 8601 with an offset | `"2026-08-20T10:12:00"`, `"yesterday"` |
| days are real calendar dates | `"2026-13-02"`, `"last week"` |
| counts are whole numbers of at least one | `"3"`, `0`, `-1` |

The property check is the privacy boundary made mechanical. A matches document knows a label, a
day and a count; one carrying a subject, a sender or a message id is rejected rather than
uploaded, so the boundary does not depend on everyone remembering it.

Validation is deterministic: same bytes in, same errors out, in the same order. It never
edits, never fills in defaults, never drops a bad label to make the rest pass.

## Authentication

The Drive connector's own OAuth, handled by the MCP server. **No credentials in this
repository**, no tokens in files, nothing to configure here. If the Drive tools are missing or
every query comes back empty, the connector is not connected or the grant covers no files — say
so rather than working around it.

This is a *different* connector from the Gmail one the Inbox Labeler uses. Being authenticated
for Gmail says nothing about Drive, and vice versa.

## Out of scope

Not this skill's business, and not to be added to it: Gmail, email processing, matching labels
against messages, and any UI. Its entire surface is loading and saving the label definitions.
