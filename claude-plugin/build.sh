#!/usr/bin/env bash
# Builds the Inbox Labeler Claude plugin ZIP.
#
#   ./build.sh [output.zip]      default: dist/inbox-labeler.zip beside this script
#
# The archive holds one folder, inbox-labeler/, with the manifest, an .mcp.json that
# names Inbox Labeler's /mcp endpoint as a remote (http) MCP server, and every skill
# under skills/ without its test.sh. /mcp is the URL of the Inbox Labeler connector the
# account already has, so the plugin names that connector rather than bringing a second
# one. It carries no credential: access is that connection's Google sign-in.
#
# .mcp.json is written into the staged copy only, so the repository holds no file a
# Claude session opened here would load as a project MCP server. The skills are copied
# at build time exactly as the ChatGPT plugin's build copies them, so skills/ stays the
# one copy of each and both plugins ship the same files.

set -euo pipefail

HERE="$(cd -P "$(dirname "$0")" && pwd -P)"
ROOT="$(dirname "$HERE")"
NAME=inbox-labeler
SERVER=inbox-labeler
URL=https://inboxlabeler.com/mcp

out="${1:-$HERE/dist/$NAME.zip}"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
pkg="$stage/$NAME"

mkdir -p "$pkg/.claude-plugin" "$pkg/skills"
cp "$HERE/.claude-plugin/plugin.json" "$pkg/.claude-plugin/plugin.json"
python3 -I -c 'import json, sys
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump({"mcpServers": {sys.argv[2]: {"type": "http", "url": sys.argv[3]}}}, f, indent=2)
    f.write("\n")' "$pkg/.mcp.json" "$SERVER" "$URL"
for skill in "$ROOT"/skills/*/; do
    skill="${skill%/}"
    cp -R "$skill" "$pkg/skills/"
    rm -f "$pkg/skills/$(basename "$skill")/test.sh"
done

# Always a new archive: pointed at an existing one, zip would update it in place and
# keep entries that are no longer staged.
(cd "$stage" && zip -qrX "$stage/$NAME.zip" "$NAME" -x '*.DS_Store')
mkdir -p "$(dirname "$out")"
mv -f "$stage/$NAME.zip" "$out"
echo "$out"
