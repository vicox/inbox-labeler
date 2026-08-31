#!/usr/bin/env bash
# Inbox Labeler process-skill contract tests.
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
# Order matters: it is what distinguishes "detection, then derived" from a
# document that merely mentions both.
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
    "$(sed -n '2p' "$SKILL")" "name: inbox-labeler-process"
check "there is a description, and the block closes on line 4" \
    "$(sed -n '3p' "$SKILL" | cut -c1-12)|$(sed -n '4p' "$SKILL")" "description:|---"

echo
echo "--- scope: what a run is allowed to look at ---"

check "a message is the unit of work, and only unread inbox mail is touched" \
    "$(order_check 'A **message** is the unit of work — never a thread' \
        'Only unread inbox messages are ever touched, so archived mail and read mail are out of scope')" \
    "True"
check "unread is a scope filter, and the run never changes it" \
    "$(order_check 'Unread is only a scope filter' 'never change the unread state' \
        'never treat unread as the processing state')" "True"
check "the absence of IL/processed is not sufficient on its own" \
    "$(order_check 'The absence of `IL/processed` is never sufficient on its own' \
        'in the inbox **and** unread **and** lacks `IL/processed`')" "True"

selection=(
    'in:inbox is:unread -label:<IL/processed id>'
    'pageSize: 50'
    'Work through the pages in order, and stop at ten messages'
    'pick out the individual messages that are in the inbox, unread, and lack the `IL/processed` id in `labelIds`'
    'check every message and skip the ones that do not qualify'
    'count only the ones you actually process against the ten'
)
check "the canonical query, the per-message recheck and the per-message count" \
    "$(order_check "${selection[@]}")" "True"

echo
echo "--- the bound is a maximum, not a target ---"

check "a run handles at most ten, and fewer or none is fine" \
    "$(order_check 'A run processes no more than ten messages, and then stops' \
        'if only three are eligible, a run handles three; if none are, it handles none')" "True"
check "ten is stated as a hard maximum" \
    "$(order_check 'Ten is a hard maximum, not a target')" "True"
check "exhausted results end the run" \
    "$(order_check 'When the search results run out, the run is over' \
        'once ten have been processed, stop and fetch no further page' \
        'If the pages run out first, you are done — fewer than ten is fine, and so is none')" "True"

echo
echo "--- step zero: no labels, no processing ---"

check "get_labels is the store, and there is nothing local to load" \
    "$(order_check 'Call `get_labels`' \
        'That is the store; there is nothing local and nothing to load first')" "True"
check "an empty list stops the run, and a failed call stops it too" \
    "$(order_check 'It returns an empty list' 'Do not process anything and do not invent a starter set' \
        'The call fails' 'Report the error verbatim and stop')" "True"
check "step zero and its stop rules come before the first Gmail step" \
    "$(order_check '## Step zero: make sure labels are available' \
        'Call `get_labels`' \
        'It returns an empty list' \
        'Report the error verbatim and stop' \
        'Complete [step zero](#step-zero-make-sure-labels-are-available)' \
        'Find candidate threads with `search_threads`' \
        'in:inbox is:unread -label:<IL/processed id>')" "True"

echo
echo "--- the two stages ---"

check "detection runs first, derived only after it has finished" \
    "$(order_check '**Detection stage.**' 'apply `IL/no-match`' \
        '**Derived stage**, only after the detection stage has finished')" "True"
check "IL/no-match comes from the detection stage alone" \
    "$(order_check '`IL/no-match` reflects the detection stage' 'never both' \
        'Derived labels do not affect it')" "True"
check "a role says what kind of fact a label found, and nothing about deciding it" \
    "$(order_check "**A detection label's \`role\` says what kind of fact it is, and changes nothing about how it is" \
        'Neither role is exclusive' \
        'There is no primary category and no primary attribute' \
        'not required to match a category, or an attribute, or one of each')" "True"
check "no-match stays role-agnostic, and a role-less label is judged like any other" \
    "$(order_check 'still means no *detection* label matched, whatever their roles' \
        'modelled before the distinction existed' \
        'never infer a role for it')" "True"
check "the role takes no part in the detection decision" \
    "$(order_check "A label's \`role\` takes no part in that decision")" "True"

check "required_labels is an AND gate" \
    "$(order_check 'detection labels that must **all** have matched' \
        'Skip a derived label whose `required_labels` did not all match')" "True"
check "recommended_labels are context, not a gate" \
    "$(order_check '`recommended_labels` are context, not a gate' 'evaluate the label anyway')" "True"

echo
echo "--- what the run writes ---"

check "IL/processed goes on last, and only when earned" \
    "$(order_check 'Apply `IL/processed` last, once both stages finished' \
        'leave `IL/processed` off so the message is picked up again on the next run' \
        '`IL/processed` is always last and always earned')" "True"
check "the run never changes UNREAD, never stars, never archives or deletes" \
    "$(order_check 'Never add or remove `STARRED`, never add or remove `UNREAD`' \
        'never archive, delete, or reply' \
        '`STARRED` and `UNREAD` belong to `inbox-labeler-attention`, and to nothing else')" "True"
check "labelling only ever adds" \
    "$(order_check 'Labelling only ever adds' 'This run removes no label from any message')" "True"

echo
echo "--- record_matches ---"

check "one call per message, after it is fully labelled" \
    "$(order_check 'Every message this run labelled gets one call, once it is fully labelled' \
        'One call per message, naming every business label that matched it' \
        'without their `IL/` prefix')" "True"
check "the state markers are never recorded, and a no-match message has no call" \
    "$(order_check 'are never recorded' 'so it has no call')" "True"

echo
echo "--- Gmail label colors ---"

# The contract is the mapping and the reason for it: colour follows what a label
# is, and the four families are exact Gmail palette values. The table is read in
# document order so a row cannot be silently swapped for another.
colors=(
    'What a label **is** decides its business label'
    'detection, `role: "category"` | `#a4c2f4` | `#000000`'
    'detection, `role: "attribute"` | `#fce8b3` | `#000000`'
    'derived | `#efa093` | `#000000`'
    'detection with no `role` | `#cccccc` | `#000000`'
)
check "category is blue, attribute amber, derived coral, a role-less label grey" \
    "$(order_check "${colors[@]}")" "True"
check "the values are Gmail palette tiles, passed exactly as written" \
    "$(order_check 'tiles from Gmail' 'pass them exactly as written')" "True"
check "attention never decides a business label colour" \
    "$(order_check 'Attention has nothing to do with a color' \
        'the same blue whether it asks for `high`, `normal` or `none`')" "True"
check "a role-less label is grey for want of a decision, not for asking nothing" \
    "$(order_check 'not because it asks for nothing' 'never fills one in')" "True"
check "colours are written in one step, and only when they differ" \
    "$(order_check 'Colors are written in step 2 and nowhere else' \
        'matching already → do nothing')" "True"
check "the reserved labels stay uncoloured" \
    "$(order_check '`IL/processed` and `IL/no-match` get no color')" "True"
check "attention is carried through the run without being used by it" \
    "$(order_check 'carried for `inbox-labeler-attention`, unused here')" "True"

echo
echo "--- what this skill leaves out ---"

check "no label CRUD guidance was carried over" \
    "$(grep -ciE 'delete_label|new_label|reuse question|rejection question' "$SKILL")" "0"
check "no attention execution, and no local storage or CLI" \
    "$(grep -ciE 'mark_read_after|star: true|unlabel_message|python3 |labels\.json|matches\.json|gdrive' "$SKILL")" \
    "0"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
