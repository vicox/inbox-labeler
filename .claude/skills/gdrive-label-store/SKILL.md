---
name: gdrive-label-store
description: Load and save the Inbox Labeler's label definitions in the Google Drive folder "Inbox Labeler". The canonical definitions are the most recently modified labels.json there. Use when the user wants to fetch labels from Drive, check them, or write changes back. Not a general Google Drive integration and not involved in email processing.
---

# Google Drive Label Store

The Inbox Labeler's label definitions live in Google Drive:

```text
Inbox Labeler/
    labels.json          ← the most recently modified one is canonical
```

The folder is the product workspace and may gain other files later, so **always locate the
folder first, then the files inside it** — never search Drive-wide for `labels.json`.

This skill loads those definitions and saves them back. It does nothing else: no Gmail, no
email processing, no label interpretation. Those belong to the `inbox-labeler` skill.

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
python3 label_store.py validate FILE            # every error, exit 1 if any
python3 label_store.py format   FILE [--write]  # stable, human-readable JSON
```

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

The local copy is scratch. Drive holds the truth, so never leave a change only in the copy.

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

Do not try to replace or delete the previous version. There is no update-in-place and no delete
tool, and the newest file is canonical anyway.

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
| reserved names refused | `processed`, `nomatch` |
| no `IL/` prefix stored | `IL/Invoice` |
| references resolve | `required_labels: ["Ghost"]` |
| references point at detection labels | a derived label referencing a derived label |
| no circular dependencies | `A → B → A`, or `A → A` |

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
