#!/usr/bin/env bash
# Inbox Labeler attention-skill contract tests.
#
#   ./test.sh
#
# These are Markdown *contract regression* tests, not natural-language semantic
# validators. They answer one question — "did someone remove or alter an explicit
# contract rule?" — by looking for the canonical wording each rule is written in,
# in the order the document states it.
#
# They deliberately do NOT attempt to prove that no English sentence anywhere in
# the file could contradict the contract. An earlier version tried, with regexes
# that guessed whether prose licensed a runtime behaviour; equivalent wordings
# kept slipping past it and valid prohibitions kept tripping it. That is not a
# job for a skill test, and the machinery is gone. A contradictory sentence added
# alongside these phrases would pass here — the tests catch deletion and edit of
# the contract, which is what regressions actually look like.
#
# Markers avoid apostrophes: they are passed inside single-quoted shell words.
#
# Prints one line per check and exits non-zero if any of them fails.

set -u

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
SKILL="$SCRIPT_DIR/SKILL.md"
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

# Every marker must appear, in the order given, in the whitespace-collapsed file.
cat > "$WORK/order.py" <<'PYEOF'
import os, re, sys
flat = re.sub(r"\s+", " ", open(os.environ["SKILL"], encoding="utf-8").read())
start = 0
for marker in sys.argv[1:]:
    index = flat.find(re.sub(r"\s+", " ", marker), start)
    if index < 0:
        print("OUT OF ORDER OR MISSING: %s" % marker)
        raise SystemExit
    start = index + 1
print(True)
PYEOF

order_check() { SKILL="$SKILL" python3 "$WORK/order.py" "$@"; }

echo "--- frontmatter ---"

check "the file opens with the YAML delimiter, no leading blank line" \
    "$(sed -n '1p' "$SKILL")" "---"
check "the name is the skill own name" \
    "$(sed -n '2p' "$SKILL")" "name: inbox-labeler-attention"
check "there is a description, and the block closes on line 4" \
    "$(sed -n '3p' "$SKILL" | cut -c1-12)|$(sed -n '4p' "$SKILL")" "description:|---"

echo
echo "--- scope: the mirror image of processing ---"

check "the scope is inbox, unread and carrying IL/processed" \
    "$(order_check 'Only **unread inbox messages that carry `IL/processed`**')" "True"
check "archived and read mail are out of scope for both skills" \
    "$(order_check 'archived mail and read mail are out of scope for both')" "True"

scope=(
    'in:inbox is:unread label:<IL/processed id>'
    'only mail that **has** been processed'
    'pick out the messages that are in the inbox, unread and carry `IL/processed`'
)
check "the canonical scope query and the per-message recheck" \
    "$(order_check "${scope[@]}")" "True"
check "a thread can mix in-scope and out-of-scope messages, so each is rechecked" \
    "$(order_check 'check every message and skip the ones that do not qualify')" "True"

echo
echo "--- step zero: no labels, no attention ---"

check "get_labels is the store, and there is nothing local to load" \
    "$(order_check 'Call `get_labels`' \
        'That is the store; there is nothing local and nothing to load first')" "True"
check "an empty list and a failed call both stop without changing a message" \
    "$(order_check 'It returns an empty list' 'Stop**, and change no message' \
        'The call fails' 'Report the error verbatim and stop')" "True"
check "step zero and its stop rules come before the first Gmail step" \
    "$(order_check '## Step zero: make sure labels are available' \
        'Call `get_labels`' \
        'It returns an empty list' \
        'Report the error verbatim and stop' \
        'Complete [step zero](#step-zero-make-sure-labels-are-available)' \
        'Find candidate threads with `search_threads`' \
        'in:inbox is:unread label:<IL/processed id>')" "True"

echo
echo "--- the labels on the message are the whole input ---"

check "the run reads labels and does not evaluate the email" \
    "$(order_check 'Read the labels already on the message' 'Do not evaluate the email' \
        'do not consult its content' 'do not reconsider whether a label belongs there')" "True"
check "it never classifies and never evaluates an instruction" \
    "$(order_check 'It never classifies' 'The labels already on the message are the whole input')" \
    "True"
check "IL/processed and IL/no-match are state, not meaning" \
    "$(order_check 'Ignore `IL/processed` and `IL/no-match`' 'they are state, not meaning')" "True"
check "only configured labels participate, and none is ever guessed" \
    "$(order_check 'takes no part in the calculation' 'never guess its Attention')" "True"

echo
echo "--- the ranking and the fixed behaviours ---"

ranking=(
    'ranked `high` > `none` >'
    'one label at `high` → `high`'
    'otherwise, one label at `none` → `none`'
    'otherwise → `normal`'
    'The behaviours are fixed, not configurable'
    'mark read once the message is 24h old, otherwise nothing'
    'star it, and keep it starred'
)
check "high outranks none outranks normal, and the behaviours are fixed" \
    "$(order_check "${ranking[@]}")" "True"

check "high stars, none clears UNREAD, normal does nothing" \
    "$(order_check '`star` → `label_message` with `STARRED`' \
        '`mark_read` → `unlabel_message` with `UNREAD`' \
        'nothing → leave the message untouched')" "True"
check "age is counted from receipt, and 24h is inclusive" \
    "$(order_check 'Ages count from **when the message was received**' \
        '24h threshold is inclusive')" "True"
check "an action whose state already holds is skipped" \
    "$(order_check 'Skip an action whose state already holds')" "True"

echo
echo "--- boundaries ---"

check "it runs only when asked, and never as part of or after a processing run" \
    "$(order_check 'Run this only when the user asks for it' \
        'it is not part of a processing run, it does not follow one' \
        'a processing run must never chain into it on its own initiative')" "True"
check "STARRED and UNREAD are the only two writes" \
    "$(order_check '`STARRED` and `UNREAD` are the only two things this run writes')" "True"
check "it never touches an IL/ label, and never recolors one" \
    "$(order_check 'It never touches an `IL/` label, in either direction' \
        'not even `IL/processed`, and no recoloring either')" "True"
check "it never calls record_matches" \
    "$(order_check 'It never calls `record_matches`' 'Recording belongs to processing')" "True"
check "it never archives, deletes or replies" \
    "$(order_check 'It never archives, deletes or replies')" "True"
check "it never touches unprocessed, non-inbox or already-read mail" \
    "$(order_check 'It never touches mail without `IL/processed`' \
        'mail outside the inbox, or mail that is already read')" "True"
check "it reports what changed and what was left alone" \
    "$(order_check 'Report what changed per message, what was left alone')" "True"

echo
echo "--- what this skill leaves out ---"

check "no detection or derived evaluation was carried over" \
    "$(grep -ciE 'Detection stage|Derived stage|derived-label prompt|required_labels|recommended_labels' "$SKILL")" \
    "0"
check "no label CRUD, no record_matches call shape, no local storage" \
    "$(grep -ciE 'create_label|update_label|delete_label|new_label|email_timestamp|python3 |labels\.json|gdrive' "$SKILL")" \
    "0"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
