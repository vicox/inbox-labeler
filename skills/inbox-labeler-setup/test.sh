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
# a type, an Attention level and a reference list, plus fifteen instructions,
# twelve of which must still be the tested wording from data/labels.example.json.
#
# Markers avoid apostrophes: they are passed inside single-quoted shell words.
#
# Prints one line per check and exits non-zero if any of them fails.

set -u

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/../.." && pwd -P)"
SKILL="$SCRIPT_DIR/SKILL.md"
EXAMPLES="$REPO_ROOT/data/labels.example.json"
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
# a blockquote — and answers one question about them. Everything it does is
# literal: both comparisons are string equality after whitespace collapsing,
# never a reading of what an instruction means. The twelve reused instructions
# are compared against data/labels.example.json; the three written for this
# skill have no such source, so their reviewed text is pinned here instead.
# Between them every one of the fifteen is fixed data.
cat > "$WORK/instructions.py" <<'PYEOF'
import json, os, re, sys

AUTHORED = {                     # the three written for this skill,
                                 # canonical text from the reviewed SKILL.md
    "Deadline": """
        The message states a concrete deadline, due date, expiration,
        cutoff, or latest time by which something must or may be done —
        'submit by 30 October', 'payment due Friday', 'respond before 5 PM',
        'registration closes 10 September', 'offer expires tomorrow',
        'documents must arrive by the 15th'. What matters is that a specific
        point in time is named by which something has to happen; the
        recipient does not have to be the one who acts, as long as the
        message communicates a concrete deadline that concerns them. Judge a
        relative date against the email's own date, not the current date.
        Does not match vague urgency with no stated cutoff ('as soon as
        possible', 'don't miss out', 'limited time'). This label says
        nothing about whether the deadline is near — that is Imminent — so a
        deadline months away matches just as fully as one tomorrow.
    """,
    "Cancellation": """
        The message states that something planned, booked, scheduled,
        ordered, subscribed or reserved has been cancelled, or is being
        cancelled by the sender: a cancelled flight, a cancelled
        appointment, a cancelled reservation, a cancelled order, a cancelled
        event, a subscription cancellation confirmation. The cancellation
        has to be an accomplished fact the message reports — 'Your booking
        has been cancelled' matches; 'Please cancel my booking' does not,
        because nothing has been cancelled yet. Does not match cancellation
        policies, instructions explaining how to cancel, marketing that
        mentions 'cancel anytime', or a hypothetical cancellation. It is not
        restricted to travel: a cancelled dentist appointment and a
        cancelled software subscription match the same way.
    """,
    "Travel disruption": """
        A booked or planned part of the trip has been cancelled, so the trip
        itself is now disrupted and has to be rearranged — a cancelled
        flight, train, ferry, hotel reservation, rental car or other travel
        booking. Read the two detection matches as established facts and
        decide only whether together they amount to a disruption of a trip
        of the recipient's own. Does not apply when the cancellation is not
        part of such a trip: a general travel cancellation policy, travel
        marketing, or a cancellation mentioned by a travel provider that
        affects no booking of theirs.
    """,
}

REUSED = [                       # starter label, label it was taken from
    ("Action required", "Action required"), ("Question", "Question"),
    ("Imminent", "Imminent"), ("Invoice", "Invoices"),
    ("Large amount", "Large amount"), ("Delivery", "Delivery"),
    ("Marketing", "Marketing"), ("Newsletter", "Newsletter"),
    ("Travel", "Travel"), ("Large invoice", "Large invoice"),
    ("Delivery arriving soon", "Delivery arriving soon"),
    ("Promotional newsletter", "Promotional newsletter"),
]

flat = lambda s: re.sub(r"\s+", " ", s).strip()
md = open(os.environ["SKILL"], encoding="utf-8").read()
blocks = re.findall(r"\*\*(\d+)\. `([^`]+)`\*\* — [^\n]*\n\n((?:> [^\n]*\n)+)", md)
order = [name for _, name, _ in blocks]
text = {name: flat("".join(line[2:] for line in quote.splitlines(True)))
        for _, name, quote in blocks}

what = sys.argv[1]
if what == "count":
    print(len(blocks))
elif what == "order":
    print(",".join(order))
elif what == "new":
    print(",".join(n for n in order if n not in dict(REUSED)))
elif what == "reused":
    source = {l["label"]: l["instruction"]
              for l in json.load(open(sys.argv[2], encoding="utf-8"))}
    missed = [new for new, old in REUSED if text.get(new) != flat(source[old])]
    print("%d/%d%s" % (len(REUSED) - len(missed), len(REUSED),
                       "" if not missed else " " + ",".join(missed)))
elif what == "authored":
    missed = [name for name, want in AUTHORED.items() if text.get(name) != flat(want)]
    print("%d/%d%s" % (len(AUTHORED) - len(missed), len(AUTHORED),
                       "" if not missed else " " + ",".join(missed)))
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
    "$(grep -cF '| `detection` | `normal` |' "$SKILL")" "11"

detection=(
    '| 1 | `Action required` | `detection` | `normal` | — |'
    '| 2 | `Question` | `detection` | `normal` | — |'
    '| 3 | `Imminent` | `detection` | `normal` | — |'
    '| 4 | `Deadline` | `detection` | `normal` | — |'
    '| 5 | `Cancellation` | `detection` | `normal` | — |'
    '| 6 | `Invoice` | `detection` | `normal` | — |'
    '| 7 | `Large amount` | `detection` | `normal` | — |'
    '| 8 | `Delivery` | `detection` | `normal` | — |'
    '| 9 | `Marketing` | `detection` | `normal` | — |'
    '| 10 | `Newsletter` | `detection` | `normal` | — |'
    '| 11 | `Travel` | `detection` | `normal` | — |'
)
check "the eleven detection labels are the agreed ones, in the agreed order" \
    "$(order_check "${detection[@]}")" "True"

check "Large invoice requires Invoice and Large amount, at high" \
    "$(order_check '| 12 | `Large invoice` | `derived` | `high` | `Invoice`, `Large amount` |')" "True"
check "Delivery arriving soon requires Delivery and Imminent, at high" \
    "$(order_check '| 13 | `Delivery arriving soon` | `derived` | `high` | `Delivery`, `Imminent` |')" \
    "True"
check "Promotional newsletter requires Marketing and Newsletter, at none" \
    "$(order_check '| 14 | `Promotional newsletter` | `derived` | `none` | `Marketing`, `Newsletter` |')" \
    "True"
check "Travel disruption requires Travel and Cancellation, at high" \
    "$(order_check '| 15 | `Travel disruption` | `derived` | `high` | `Travel`, `Cancellation` |')" \
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
    "$(order_check 'create_label   label:       "Invoice"' 'attention:   "normal"' \
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
check "  …in the same order as the table" \
    "$(blocks order)" \
    "Action required,Question,Imminent,Deadline,Cancellation,Invoice,Large amount,Delivery,Marketing,Newsletter,Travel,Large invoice,Delivery arriving soon,Promotional newsletter,Travel disruption"
check "exactly three instructions are newly written" \
    "$(blocks new)" "Deadline,Cancellation,Travel disruption"
check "the twelve reused instructions are identical to labels.example.json" \
    "$(blocks reused "$EXAMPLES")" "12/12"
check "the three newly written instructions are identical to their canonical text" \
    "$(blocks authored)" "3/3"
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
