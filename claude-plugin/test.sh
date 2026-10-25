#!/usr/bin/env bash
# Inbox Labeler Claude plugin tests.
#
#   ./test.sh
#
# Checks the manifest against the rules Anthropic documents for plugins, and the tools
# the skills name against the ones Inbox Labeler's /mcp endpoint registers. Then builds
# the ZIP, checks what is in it, and builds the ChatGPT plugin too, to check that both
# ship the same skills byte for byte. None of this proves claude.ai accepts the upload,
# only that the package has the documented shape.
#
# Writes only to a temp dir. Prints one line per check and exits non-zero if any fails.

set -u

HERE="$(cd -P "$(dirname "$0")" && pwd -P)"
ROOT="$(dirname "$HERE")"
MANIFEST="$HERE/.claude-plugin/plugin.json"
CHATGPT_MANIFEST="$ROOT/chatgpt-plugin/.codex-plugin/plugin.json"
SERVER_TS="$ROOT/web/lib/mcp/server.ts"
# The URL the README tells every client to connect to. The plugin must name it exactly:
# a different URL would be a second connector.
URL=https://inboxlabeler.com/mcp
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

check() {
    if [ "$2" = "$3" ]; then
        pass=$((pass + 1)); printf 'PASS  %s\n' "$1"
    else
        fail=$((fail + 1))
        printf 'FAIL  %s\n      got:    %s\n      wanted: %s\n' "$1" "$2" "$3"
    fi
}

# Evaluates a Python expression over a JSON file, bound to d.
cat > "$WORK/json.py" <<'PYEOF'
import json, re, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
print(eval(sys.argv[2], {"d": d, "re": re}))
PYEOF
q() { python3 -I "$WORK/json.py" "$1" "$2"; }

echo "--- manifest ---"

check "name is inbox-labeler" "$(q "$MANIFEST" 'd["name"]')" "inbox-labeler"
check "displayName is Inbox Labeler" "$(q "$MANIFEST" 'd["displayName"]')" "Inbox Labeler"
check "version is a semantic version" \
    "$(q "$MANIFEST" 'bool(re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", d["version"]))')" "True"
check "version is the ChatGPT plugin's: one set of skills, one release" \
    "$(q "$MANIFEST" 'd["version"]')" "$(q "$CHATGPT_MANIFEST" 'd["version"]')"
check "description and author.name are set" "$(q "$MANIFEST" 'bool(d["description"] and d["author"]["name"])')" "True"
# claude.ai strips a top-level key it does not know without a word, so a misspelt one is
# lost. No component path either: skills/ and .mcp.json sit where Claude looks by default.
check "every key is a documented metadata key" \
    "$(q "$MANIFEST" 'sorted(set(d) - {"name", "displayName", "version", "description", "author",
        "homepage", "repository", "license", "keywords"})')" "[]"
check "the kit commits no .mcp.json: the build writes it into the package" \
    "$([ -e "$HERE/.mcp.json" ] && echo present || echo absent)" "absent"

echo
echo "--- the tools the skills name ---"

# The skills name Inbox Labeler's own MCP tools and no Gmail tool. Every tool-shaped name
# in a SKILL.md must be one /mcp registers: a name it does not register is a call Claude
# cannot make, and a Gmail tool name would tie the skill to one host's connector.
cat > "$WORK/tools.py" <<'PYEOF'
import glob, os, re, sys
server, skills, what = open(sys.argv[1], encoding="utf-8").read(), sys.argv[2], sys.argv[3]
registered = set(re.findall(r'registerTool\(\s*"([a-z_]+)"', server))
named = set()
for path in glob.glob(os.path.join(skills, "*", "SKILL.md")):
    text = open(path, encoding="utf-8").read()
    named |= set(re.findall(r"`((?:get|list|search|create|update|delete|record|label|unlabel|modify|batch)_[a-z_]+)`", text))
if what == "sane":
    print(len(registered) >= 8 and {"get_labels", "record_matches", "get_representative_labels"} <= named)
elif what == "unregistered":
    print(" ".join(sorted(named - registered)) or "none")
PYEOF
tools() { python3 -I "$WORK/tools.py" "$SERVER_TS" "$ROOT/skills" "$1"; }
check "the tool registry and the skills were both read" "$(tools sane)" "True"
check "every tool a skill names is one /mcp registers" "$(tools unregistered)" "none"

echo
echo "--- package ---"

ZIP="$WORK/out/inbox-labeler.zip"
bash "$HERE/build.sh" "$ZIP" >/dev/null 2>"$WORK/build.err"
check "the build succeeds" "$?" "0"
unzip -Z1 "$ZIP" | grep -v '/$' | sort > "$WORK/files"
mkdir "$WORK/claude" && unzip -q "$ZIP" -d "$WORK/claude"
PKG="$WORK/claude/inbox-labeler"

check "every entry is under the one top-level folder inbox-labeler/" \
    "$(unzip -Z1 "$ZIP" | grep -vc '^inbox-labeler/')" "0"
check "the files are the manifest, .mcp.json and one SKILL.md per skill, and nothing else" \
    "$(tr '\n' ' ' < "$WORK/files")" \
    "$( (printf '%s\n' inbox-labeler/.claude-plugin/plugin.json inbox-labeler/.mcp.json
        cd "$ROOT/skills" && for d in */; do echo "inbox-labeler/skills/${d%/}/SKILL.md"; done) | sort | tr '\n' ' ')"
check "there are five skills" "$(grep -c '^inbox-labeler/skills/[^/]*/SKILL\.md$' "$WORK/files")" "5"
check "the manifest is the source, unchanged" \
    "$(cmp -s "$MANIFEST" "$PKG/.claude-plugin/plugin.json" && echo same)" "same"
# Exactly the documented remote shape: no headers (a credential there would ship to
# everyone who installs it), no command (claude.ai ignores a local server), and the URL
# of the existing connector, character for character.
check ".mcp.json names one http server, inbox-labeler, at exactly $URL" \
    "$(q "$PKG/.mcp.json" 'd')" "{'mcpServers': {'inbox-labeler': {'type': 'http', 'url': '$URL'}}}"

for dir in "$ROOT"/skills/*/; do
    skill="$(basename "$dir")"
    check "$skill/SKILL.md is the source, unchanged" \
        "$(cmp -s "$dir/SKILL.md" "$PKG/skills/$skill/SKILL.md" && echo same)" "same"
    check "$skill frontmatter name is its folder name" \
        "$(sed -n '2,/^---$/s/^name: *//p' "$PKG/skills/$skill/SKILL.md")" "$skill"
done

echo
echo "--- the same skills in both plugins ---"

bash "$ROOT/chatgpt-plugin/build.sh" "$WORK/chatgpt.zip" >/dev/null 2>"$WORK/chatgpt.err"
check "the ChatGPT build succeeds" "$?" "0"
mkdir "$WORK/chatgpt" && unzip -q "$WORK/chatgpt.zip" -d "$WORK/chatgpt"
check "both ZIPs hold the same skill files, byte for byte" \
    "$(diff -r "$PKG/skills" "$WORK/chatgpt/inbox-labeler/skills" >/dev/null && echo same)" "same"

echo
echo "--- fresh rebuild ---"

mkdir -p "$WORK/seed/inbox-labeler" "$WORK/fresh"
echo stale > "$WORK/seed/inbox-labeler/stale.txt"
(cd "$WORK/seed" && zip -q "$WORK/fresh/inbox-labeler.zip" inbox-labeler/stale.txt)
bash "$HERE/build.sh" "$WORK/fresh/inbox-labeler.zip" >/dev/null 2>&1
check "rebuilding over an old ZIP leaves none of its entries" \
    "$(unzip -Z1 "$WORK/fresh/inbox-labeler.zip" | grep -c 'stale\.txt')" "0"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
