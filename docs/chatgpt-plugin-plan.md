# Plan — Inbox Labeler as an installable ChatGPT plugin ZIP

Status: plan READY (review round 2), implemented · branch `inbox-labeler-plugin` · 2026-10-17

Revision 2 addresses review round 1. App IDs are now validated against the documented prefixes,
and the replacement instructions no longer point at the `plugin_…` URL ID. The build now always
writes a fresh archive. The app entry adds `"required": true`, as ChatGPT's own Tonight package
does.

## Goal

Produce one ZIP that ChatGPT accepts as a plugin named **Inbox Labeler**. It packages the five
existing skills, and it *references* the separately deployed Inbox Labeler MCP app
(`https://inboxlabeler.com/mcp`) instead of bundling it. This is a **ChatGPT plugin** (OpenAI's
plugin format), not a Claude Code plugin. No `.claude-plugin/` is involved.

Out of scope: changes to any skill's content, the web app or MCP server, icons and screenshots,
public directory submission, Gmail wiring, and anything in the user's ChatGPT, `~/.claude` or
`~/.codex`.

## Where things stand

- **The repo is not docs-only.** The local clone was 63 commits behind GitHub. The branch had no
  commits of its own, so it was fast-forwarded from `02d09ea` to `e06f8a3` (GitHub `main`). It now
  holds `skills/inbox-labeler-{setup,manage,process,attention,overview}/` (each a `SKILL.md` and a
  `test.sh`) and `web/`, the MCP server. Nothing was rebased or discarded.
- **The skills are host-neutral.** Their frontmatter has only `name` and `description`, and the
  name matches the folder. They call the MCP tools by name (`get_labels`, `create_label`, …). They
  also call Gmail tools by the names Claude's Gmail connector uses (`search_threads`, `get_thread`,
  `label_message`, `unlabel_message`, `list_labels`, `create_label`).
- **The Tonight plugin was inspected by the reviewer, not by this session.** This session cannot
  read `~/.codex`. The reviewer read the cached copy ChatGPT created,
  `~/.codex/plugins/cache/created-by-me-remote/tonight-ios-test/1.0.0/`. Its `.app.json` is
  `{"apps":{"tonight":{"id":"asdk_app_6a98…","required":true}}}`, and it ships both a root
  `plugin.json` and `.codex-plugin/plugin.json`. The `tonight` repo itself contains no plugin
  packaging.

## Evidence

| Source | What it settles |
| --- | --- |
| `openai/skills` → `skills/.system/plugin-creator/` (`SKILL.md`, `references/plugin-json-spec.md`, `scripts/create_basic_plugin.py`) | The plugin creator scaffolds `.codex-plugin/plugin.json`. Field set: `name` (kebab-case), `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `skills`, `apps`, `interface{…}`. All paths are relative and start with `./`. `.app.json` is scaffolded as `{"apps": {}}`. `defaultPrompt` takes at most 3 entries of ≤128 characters. |
| `openai/plugins` → `plugins/chatcut`, `plugins/adobe` | Same shape we need: `.codex-plugin/plugin.json` + `skills/` + `.app.json`, **no `.mcp.json`**. |
| `openai/plugins` → `plugins/linear/.app.json`, `plugins/notion/.app.json`, `plugins/public-equity-investing/.app.json` | `.app.json` shape: `{"apps": {"<key>": {"id": "<app id>"}}}`. The key is a local alias. IDs seen: `asdk_app_…`, `connector_…`. |
| developers.openai.com/plugins/build/plugins | A custom MCP server added in ChatGPT and saved with **Create as a plugin** gets an ID that "starts with `plugin_asdk_app`", which you copy from the browser URL. `.app.json` maps a registered MCP server to that ID. `.codex-plugin/` should contain only `plugin.json`. Paths start with `./` and stay inside the plugin. |
| developers.openai.com/api/docs/guides/agents-api/tools/plugins | "Each ZIP must contain one plugin folder with `.codex-plugin/plugin.json` inside it." Manifest paths contain no `..`. Keep secrets out of the archive. |
| developers.openai.com/plugins/deploy/submission-errors | **App IDs** must begin with `asdk_app_`, `connector_` or `templated_apps_`, then a letter or digit, then only letters, digits, `_` or `-` (`app_id_format`). `id` is required. `required` and `optional` are booleans when present. **ZIP rules:** the manifest may be root `plugin.json`, `.codex-plugin/plugin.json`, `.agent-plugin/plugin.json` or `.claude-plugin/plugin.json`, "at the root or in its single top-level directory". A top-level plugin directory must have no sibling files. The ZIP needs at least one valid skill. Each skill is an immediate child of `skills/`, contains `SKILL.md`, and has a name that does not begin with `.`. |
| Cached Tonight package, read by the reviewer | `.app.json` entry `{"id": "asdk_app_…", "required": true}`. This is the shape ChatGPT itself generated for one of the user's plugins. |
| help.openai.com "Plugins in ChatGPT" | Returned 403. Search excerpts give the install path as Admin console → Plugins → Add → **Upload plugin** (ZIP). Not independently verified. |

## Decisions

1. **Manifest at `.codex-plugin/plugin.json`, with no root `plugin.json`.** The submission rules
   accept this location inside the single top-level folder (`plugin_manifest_missing`), and the
   portal saves every manifest there anyway (`manifest_normalized`). The plugin-creator script
   generates it, and every curated ChatGPT plugin uses it.

   The portable root `plugin.json` is newer, and the installed Plugin Creator now recommends it.
   But when it carries `extensions.com.openai` it *replaces* the overlay, so shipping two manifests
   would only add ambiguity. The reviewer confirmed this is not a blocker.
2. **Reference the app through `.app.json` only, with no `.mcp.json`.** A `.mcp.json` pointing at
   `https://inboxlabeler.com/mcp` would make the plugin open its *own* connection, with a fresh
   OAuth client registration. That bundles the server rather than referencing the separate app,
   and it would sit beside the user's existing installation.
3. **An app ID is needed, so ship a placeholder and validate any real one.** `id` is the one
   required field of an `.app.json` entry, so there is no way to reference the app without it. The
   real ID belongs to the user's ChatGPT account and cannot be read from here. Use the key
   `inbox-labeler-mcp`, the id `REPLACE_WITH_INBOX_LABELER_MCP_APP_ID`, and `"required": true`.
   `required` is there because the skills cannot work without the app, and ChatGPT's own Tonight
   package sets it the same way. The placeholder is deliberately not shaped like a real ID.
   - While the placeholder is present, the build warns and still produces the ZIP.
   - Any other id must match `^(asdk_app_|connector_|templated_apps_)[A-Za-z0-9][A-Za-z0-9_-]*$`.
     If it does not, the build fails. In particular, a `plugin_…` ID copied from the browser URL
     fails.
4. **Skills are copied at build time, never duplicated in git.** The README says `skills/` "is the
   one copy of each skill". The build copies each `skills/<name>/` into the package and drops
   `test.sh`. Skill content is unchanged.
5. **Leave out the optional extras:** icons and logo, screenshots, `brandColor`, hooks,
   `agents/openai.yaml`, `marketplace.json`, and Gmail in `.app.json`.

## Files

```
chatgpt-plugin/
├── .codex-plugin/plugin.json   manifest (below)
├── .app.json                   reference to the Inbox Labeler MCP app (placeholder id)
├── build.sh                    assembles dist/inbox-labeler.zip
├── test.sh                     checks the sources and the built ZIP
└── dist/                       build output, git-ignored
```

Edits elsewhere: `.gitignore` gains `chatgpt-plugin/dist/`. `README.md` gains a short *ChatGPT
plugin* subsection under *Connecting ChatGPT*, covering building, replacing the ID and uploading.
It also gets one line in the *Repository layout* tree and one in *Testing*.

### `.codex-plugin/plugin.json`

```json
{
  "name": "inbox-labeler",
  "version": "0.1.0",
  "description": "Label Gmail with categories you define, using the Inbox Labeler app for your label definitions.",
  "author": { "name": "Georg Schmidl", "url": "https://github.com/vicox" },
  "homepage": "https://inboxlabeler.com",
  "repository": "https://github.com/vicox/inbox-labeler",
  "license": "MIT",
  "keywords": ["gmail", "email", "labels", "inbox"],
  "skills": "./skills/",
  "apps": "./.app.json",
  "interface": {
    "displayName": "Inbox Labeler",
    "shortDescription": "Label your mail with categories you define",
    "longDescription": "Describe in plain language what matters to you in an email. Inbox Labeler detects it in new unread mail and applies it as a Gmail label, stars or marks read what each label asks for, and shows already processed mail grouped for scanning. Label definitions live in the Inbox Labeler app.",
    "developerName": "Georg Schmidl",
    "category": "Productivity",
    "capabilities": ["Read", "Write"],
    "websiteURL": "https://inboxlabeler.com",
    "privacyPolicyURL": "https://inboxlabeler.com/privacy",
    "termsOfServiceURL": "https://inboxlabeler.com/terms",
    "defaultPrompt": ["Set up Inbox Labeler", "Add a label for invoices", "Process my inbox"]
  }
}
```

`/privacy` and `/terms` exist as pages in `web/app/`. The default prompts are the README's own
three examples.

### `.app.json`

```json
{
  "apps": {
    "inbox-labeler-mcp": {
      "id": "REPLACE_WITH_INBOX_LABELER_MCP_APP_ID",
      "required": true
    }
  }
}
```

### `build.sh`

- Takes an optional output path, made absolute. The default is `chatgpt-plugin/dist/inbox-labeler.zip`.
- Stages in `mktemp -d`, removed on exit, with this layout:
  `inbox-labeler/.codex-plugin/plugin.json`, `inbox-labeler/.app.json`, and
  `inbox-labeler/skills/<skill>/…` for every `skills/*/`, with `test.sh` removed.
- Checks the app ID first, using `python3 -I` to read `.app.json`. The placeholder only produces a
  stderr warning, so the user gets a ZIP now. Any other id that does not match the pattern in
  Decision 3 exits non-zero before anything is written.
- **Always writes a fresh archive.** It runs `zip -qrX` from inside the staging dir into a *new*
  file in that dir, never an existing archive. The ZIP therefore has exactly one top-level folder,
  `inbox-labeler/`, and no `*.DS_Store`. It then `mv -f`s that file over the output path, so
  nothing from a previous archive can survive a rebuild. It prints the ZIP path.
- Writes only into its own output path. It touches nothing outside the worktree.

### `test.sh`

Follows the house style: a `check` helper, one `PASS`/`FAIL` line per check, non-zero exit on any
failure, `python3` for parsing. It verifies:

- Both JSON files parse. `name` is `inbox-labeler`, `skills` is `./skills/`, `apps` is `./.app.json`.
- Every manifest path starts with `./` and contains no `..`.
- `defaultPrompt` has ≤3 entries, each ≤128 characters.
- `.app.json` has exactly the one key `inbox-labeler-mcp`, with `required: true`. Its `id` is
  either the placeholder or a match for the Decision 3 pattern.
- It builds into a temp dir. Every ZIP entry starts with `inbox-labeler/`, and the ZIP holds
  `.codex-plugin/plugin.json`, `.app.json`, and one `skills/<name>/SKILL.md` for each folder
  under `skills/`. Every skill is an immediate child of `skills/`, and no skill name starts with
  `.`.
- The ZIP has no `test.sh`, no `.DS_Store`, and nothing else under `.codex-plugin/`.
- Every packaged `SKILL.md` is byte-identical to its source, and its frontmatter `name` equals its
  folder name.
- **Fresh rebuild.** The test pre-creates the output path as a ZIP holding a stale
  `inbox-labeler/stale.txt`, then rebuilds. That entry must be gone afterwards.
- **App ID validation.** The test runs the build on a temp copy of `chatgpt-plugin/`, with a
  `skills` symlink beside it and an edited `.app.json`. It checks three ids:
  - `plugin_asdk_app_abc` exits non-zero and leaves no output file.
  - `asdk_app_abc123` builds without the placeholder warning.
  - The placeholder builds with the warning.

  The source `.app.json` is never modified.

## Steps

1. Done: fast-forward the branch to GitHub `main`.
2. Add `chatgpt-plugin/.codex-plugin/plugin.json` and `chatgpt-plugin/.app.json` as above.
3. Add `chatgpt-plugin/build.sh` and `chatgpt-plugin/test.sh`, both executable, plus the
   `.gitignore` line.
4. Add the README lines.
5. Run `chatgpt-plugin/test.sh` and the five existing `skills/*/test.sh` (unchanged, as a
   regression check). Build `chatgpt-plugin/dist/inbox-labeler.zip` and list its contents.
6. Request the implementation review, and iterate until READY.

Nothing is committed or pushed unless the user asks.

## The user's existing installation

Nothing here touches ChatGPT, the deployed app, `~/.claude/skills` or `~/.codex`. Uploading the
ZIP is a manual, additive step for the user. If ChatGPT rejects the upload because a plugin or
app named *Inbox Labeler* already exists, **do not delete the existing one**. Stop and choose a
different plugin `name` instead.

**Replacing the placeholder:** `.app.json` needs the *registered app's* ID, which starts with
`asdk_app_` (or `connector_` / `templated_apps_`). It does not take the `plugin_…` ID that
ChatGPT's browser URL shows for a plugin. Get the app ID one of these ways:

- Read it from the `.app.json` of the plugin ChatGPT generated for the existing Inbox Labeler
  custom MCP server. Codex caches these under `~/.codex/plugins/cache/created-by-me-remote/`, the
  same place the Tonight one came from.
- Otherwise, take the URL's `plugin_asdk_app_…` value without its `plugin_` prefix. This is
  *inferred* from the Tonight package, not documented, so confirm it before relying on it.

Put the ID in `chatgpt-plugin/.app.json` and rerun `build.sh`. The build rejects a malformed ID.
README wording follows this paragraph.

## Implementation notes

- **The real app ID replaced the placeholder.** In round 2 the reviewer found ChatGPT's cached
  plugin for the existing Inbox Labeler MCP server, at
  `~/.codex/plugins/cache/created-by-me-remote/dev-6a9935553ca8819194b32858433d08bf/1.0.0/.app.json`.
  Its id is `asdk_app_6a9935553ca8819194b32858433d08bf`, and `.app.json` now uses it. The
  placeholder path in `build.sh` stays, for a deployment with a different connector.
- **This session cannot execute scripts or `chmod`.** Its non-interactive permission mode denies
  both, so:
  - `build.sh` and `test.sh` are mode 644, not executable like the skill tests, and `test.sh`
    invokes the build through `bash`.
  - The README calls both through `bash`.
  - The delivered ZIP was produced with `git archive --format=zip --prefix=inbox-labeler/` from a
    tree assembled with `git mktree`. That tree holds exactly the seven files `build.sh` stages:
    the manifest, `.app.json`, and the five `SKILL.md` blobs, identical to `HEAD`.
  - The implementation reviewer runs `test.sh`, which writes only to temp dirs, and compares this
    ZIP against a fresh `build.sh` output.

## Risks this plan does not resolve

- **Gmail in ChatGPT.** The skills use Claude's Gmail tool names. Whether ChatGPT's Gmail app
  exposes the same tools, including label writes, is unverified. Packaging does not change that.
  It may be a follow-up on the skills themselves.
- **Upload acceptance.** It cannot be tested from here. The ZIP layout follows the documented rule,
  but no upload was observed, and an unresolved placeholder ID will not install.
- **No icon.** ChatGPT shows its default icon until assets are added.
