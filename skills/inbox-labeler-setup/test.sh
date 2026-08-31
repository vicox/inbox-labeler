#!/usr/bin/env bash
# Inbox Labeler setup-skill contract tests.
#
#   ./test.sh
#
# These are Markdown *contract regression* tests, not natural-language semantic
# validators. They answer one question — "did someone remove or alter an explicit
# contract rule?" — by checking canonical wording, exact table data, counts and
# document order.
#
# They deliberately do NOT attempt to prove that no English sentence in the file
# could contradict the contract. An earlier version tried, with regexes that
# guessed whether prose licensed a runtime behaviour; that is not a job for a
# skill test, and the machinery is gone. A contradictory sentence added alongside
# these markers would pass here — the tests catch deletion and edit of the
# contract, which is what regressions actually look like.
#
# Most of the value is in the starter set, which is pure data: fifteen rows with
# a type, an Attention level and a reference list, and fifteen instructions that
# have to be the fifteen labels of that table, in its order.
#
# The instruction *text* is not pinned anywhere. SKILL.md is the only definition
# of what Setup creates, and a second copy of those instructions — in a fixture or
# in this file — would only be a second thing to keep true. Rewording one is a
# review question, not something this suite can answer.
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

# Reads the instruction blocks — "**N. `Label`** — type, `attention`" followed by
# a blockquote — and answers one question about them, all of it literal.
cat > "$WORK/instructions.py" <<'PYEOF'
import os, re, sys
# The instruction blocks, checked against the table above them — both read out of
# the same file. Nothing here holds a copy of an instruction: the question it
# answers is whether the two halves of SKILL.md still describe the same fifteen
# labels in the same order, which is what silently breaks when one is edited.
md = open(os.environ["SKILL"], encoding="utf-8").read()

table = re.findall(r"^\| \d+ \| `([^`]+)` \|", md, re.M)
blocks = re.findall(r"^\*\*(\d+)\. `([^`]+)`\*\* — [^\n]*\n\n(?:> [^\n]*\n)+", md, re.M)
order = [name for _, name in blocks]

what = sys.argv[1]
if what == "count":
    print(len(blocks))
elif what == "numbering":
    print(",".join(n for n, _ in blocks))
elif what == "agree":
    print("yes" if order == table else f"table={table} blocks={order}")
PYEOF

order_check() { SKILL="$SKILL" python3 "$WORK/order.py" "$@"; }
blocks()      { SKILL="$SKILL" python3 "$WORK/instructions.py" "$@"; }

echo "--- frontmatter ---"

# 2d2d2d is "---". A BOM would put efbbbf in front of it, and a leading blank
# line would put 0a there — either one stops the frontmatter being parsed.
check "the frontmatter opens at byte 1, with no BOM and no blank line" \
    "$(head -c 3 "$SKILL" | od -An -tx1 | tr -d ' \n')|$(sed -n '1p' "$SKILL")" "2d2d2d|---"
check "the name is the skill own name" \
    "$(sed -n '2p' "$SKILL")" "name: inbox-labeler-setup"
check "there is the agreed description, and the block closes on line 4" \
    "$(sed -n '3p' "$SKILL")|$(sed -n '4p' "$SKILL")" \
    "description: Set up an empty Inbox Labeler with a useful starter label configuration.|---"

echo
echo "--- step zero comes before anything is created ---"

check "get_labels is the first operational step, ahead of the starter set" \
    "$(order_check '## Step zero: look before you write' \
        'Call `get_labels` first' \
        'It returns business labels' \
        'It returns an empty list' \
        'The call fails' \
        '## The starter set' \
        'create_label   label:       "Invoice"')" "True"
check "emptiness is never assumed, and get_labels is the source of truth" \
    "$(order_check 'Never assume the configuration is empty' \
        'the only source of truth for this decision' 'Do not inspect the inbox')" "True"
check "an existing configuration stops setup and is handed to manage" \
    "$(order_check 'Stop, and create nothing' 'already configured' 'inbox-labeler-manage')" "True"
check "an existing configuration is never overwritten, reset, deleted or merged into" \
    "$(order_check 'Do not overwrite them, do not reset them, do not delete them' \
        'do not change their definitions' 'do not quietly merge the starter set in beside them')" \
    "True"
check "an empty list is the normal starting state, and a failed call stops with no partial set" \
    "$(order_check 'the normal starting state, not an error' \
        'Report the error verbatim and stop' 'do not create part of the set')" "True"
check "the reserved system labels do not count as a configured set" \
    "$(order_check '`processed` and `no-match` are **reserved system labels**' \
        'never business labels' 'never count towards a configured set')" "True"

echo
echo "--- the starter set: fifteen rows of data ---"

check "the table holds exactly fifteen labels" \
    "$(grep -cE '^\| [0-9]+ \| `' "$SKILL")" "15"
check "eleven of them are detection" "$(grep -cF '| `detection` |' "$SKILL")" "11"
check "four of them are derived"     "$(grep -cF '| `derived` |' "$SKILL")" "4"
check "every detection label is at normal attention" \
    "$(grep -cE '^\| [0-9]+ \| `[^`]+` \| `detection` \| `(category|attribute)` \| `normal` \| — \|$' "$SKILL")" \
    "11"

# The roles, as counts and then as rows. Four kinds of mail and seven facts that can
# turn up inside any of them — a set that drifted to eleven categories would still
# pass every other check here.
check "four of the detection labels are categories" \
    "$(grep -cF '| `detection` | `category` |' "$SKILL")" "4"
check "seven of them are attributes" \
    "$(grep -cF '| `detection` | `attribute` |' "$SKILL")" "7"
check "no derived label carries a role" \
    "$(grep -cE '^\| [0-9]+ \| `[^`]+` \| `derived` \| — \|' "$SKILL")" "4"

detection=(
    '| 1 | `Action required` | `detection` | `attribute` | `normal` | — |'
    '| 2 | `Question` | `detection` | `attribute` | `normal` | — |'
    '| 3 | `Imminent` | `detection` | `attribute` | `normal` | — |'
    '| 4 | `Deadline` | `detection` | `attribute` | `normal` | — |'
    '| 5 | `Cancellation` | `detection` | `attribute` | `normal` | — |'
    '| 6 | `Invoice` | `detection` | `category` | `normal` | — |'
    '| 7 | `Large amount` | `detection` | `attribute` | `normal` | — |'
    '| 8 | `Delivery` | `detection` | `category` | `normal` | — |'
    '| 9 | `Marketing` | `detection` | `attribute` | `normal` | — |'
    '| 10 | `Newsletter` | `detection` | `category` | `normal` | — |'
    '| 11 | `Travel` | `detection` | `category` | `normal` | — |'
)
check "the eleven detection labels are the agreed ones, in the agreed order" \
    "$(order_check "${detection[@]}")" "True"

check "Large invoice requires Invoice and Large amount, at high" \
    "$(order_check '| 12 | `Large invoice` | `derived` | — | `high` | `Invoice`, `Large amount` |')" "True"
check "Delivery arriving soon requires Delivery and Imminent, at high" \
    "$(order_check '| 13 | `Delivery arriving soon` | `derived` | — | `high` | `Delivery`, `Imminent` |')" \
    "True"
check "Promotional newsletter requires Marketing and Newsletter, at none" \
    "$(order_check '| 14 | `Promotional newsletter` | `derived` | — | `none` | `Marketing`, `Newsletter` |')" \
    "True"
check "Travel disruption requires Travel and Cancellation, at high" \
    "$(order_check '| 15 | `Travel disruption` | `derived` | — | `high` | `Travel`, `Cancellation` |')" \
    "True"
check "no derived label takes recommended_labels" \
    "$(order_check 'None of the four derived labels takes `recommended_labels`; pass an empty list')" \
    "True"
check "no label outside the agreed fifteen" \
    "$(grep -coE 'Travel preparation|Sales inquiry|Informational|Account security|Imminent deadline|\bUrgent\b' "$SKILL")" \
    "0"

echo
echo "--- how the set is created ---"

check "detection labels are created before derived ones, so every reference exists" \
    "$(order_check 'Create them in the order of that table' \
        'detection labels 1–11 before derived labels 12–15' \
        'a reference to a label that does not exist yet is rejected')" "True"
check "the create_label contract carries type, attention and both reference lists" \
    "$(order_check 'create_label   label:       "Invoice"' 'role:        "category"' \
        'attention:   "normal"' \
        'create_label   label:               "Large invoice"' 'type:                "derived"' \
        'attention:           "high"' 'required_labels:     ["Invoice", "Large amount"]' \
        'recommended_labels:  []')" "True"
check "stored names are unprefixed, and IL/ is added later by processing" \
    "$(order_check '`IL/` is Inbox Labeler' 'added later when processing talks to Gmail' \
        'never put it in a stored label name')" "True"
check "required_labels is an AND gate, and there is no third type" \
    "$(order_check 'every one of them must have matched, or the derived label is not evaluated at all' \
        'there is no chaining, and there is no third type')" "True"

echo
echo "--- the instructions ---"

check "there are fifteen instruction blocks, one per starter label" "$(blocks count)" "15"
check "  …the table labels, in the table order" "$(blocks agree)" "yes"
check "  …numbered 1 to 15, so the list and the table can be read together" \
    "$(blocks numbering)" "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15"
check "the instructions are copied verbatim, not paraphrased" \
    "$(order_check 'Do not paraphrase them, shorten them or adapt them to the user')" "True"

echo
echo "--- boundaries and failure ---"

check "setup never inspects or classifies mail" \
    "$(order_check 'This never touches mail' \
        'never searches Gmail, never opens a thread, never classifies anything' \
        'never stars or marks anything, and never records a match')" "True"
check "setup does not run processing or attention afterwards" \
    "$(order_check 'do not continue into processing' \
        'Setting up labels does not mean running them' \
        'classifying mail is `inbox-labeler-process`, and it runs when the user asks for it')" "True"
check "partial failure is reported, and success is not claimed" \
    "$(order_check 'Never claim the setup succeeded unless all fifteen labels were created' \
        'A partial set is a partial set' 'Do not pretend it completed')" "True"
check "no rollback is invented" \
    "$(order_check 'do not delete the labels that did succeed' \
        'Inbox Labeler offers no such rollback')" "True"
check "no manage CRUD or runtime tool was carried over" \
    "$(grep -coE 'update_label|delete_label|new_label|record_matches|search_threads|label_message' "$SKILL")" \
    "0"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
