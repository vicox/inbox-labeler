#!/usr/bin/env bash
# Builds the Inbox Labeler ChatGPT plugin ZIP.
#
#   ./build.sh [output.zip]      default: dist/inbox-labeler.zip beside this script
#
# The archive holds one folder, inbox-labeler/, with the manifest, the reference to
# the separately installed Inbox Labeler MCP app, and every skill under skills/
# without its test.sh. The skills are copied at build time, so skills/ stays the
# one copy of each.

set -euo pipefail

HERE="$(cd -P "$(dirname "$0")" && pwd -P)"
ROOT="$(dirname "$HERE")"
NAME=inbox-labeler
PLACEHOLDER=REPLACE_WITH_INBOX_LABELER_MCP_APP_ID
APP_ID_FORMAT='^(asdk_app_|connector_|templated_apps_)[A-Za-z0-9][A-Za-z0-9_-]*$'

out="${1:-$HERE/dist/$NAME.zip}"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac

# The registered app's ID, not the plugin_… ID ChatGPT's browser URL shows.
id="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["apps"]["inbox-labeler-mcp"]["id"])' "$HERE/.app.json")"
if [ "$id" = "$PLACEHOLDER" ]; then
    echo "warning: .app.json still holds the placeholder app ID; replace it before installing" >&2
elif ! [[ "$id" =~ $APP_ID_FORMAT ]]; then
    echo "error: app ID \"$id\" must start with asdk_app_, connector_ or templated_apps_" >&2
    exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
pkg="$stage/$NAME"

mkdir -p "$pkg/.codex-plugin" "$pkg/skills"
cp "$HERE/.codex-plugin/plugin.json" "$pkg/.codex-plugin/plugin.json"
cp "$HERE/.app.json" "$pkg/.app.json"
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
