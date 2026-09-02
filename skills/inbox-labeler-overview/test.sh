#!/usr/bin/env bash
# Inbox Labeler overview-skill contract tests.
#
#   ./test.sh
#
# These are Markdown *contract regression* tests, not natural-language semantic
# validators. They answer one question — "did someone remove or alter an explicit
# contract rule?" — by looking for the canonical wording each rule is written in,
# in the order the document states it.
#
# Two rules have teeth beyond wording, and both are about where something lives
# rather than how it is phrased: the ranking must stay delegated to
# `get_representative_labels` rather than be restated here, and the presentation
# must stay host-generic rather than name one host's API. The ranking itself is
# tested in web/lib/inbox/overview.test.ts.
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
    "$(sed -n '2p' "$SKILL")" "name: inbox-labeler-overview"
check "there is a description, and the block closes on line 4" \
    "$(sed -n '3p' "$SKILL" | cut -c1-12)|$(sed -n '4p' "$SKILL")" "description:|---"

echo
echo "--- scope, and that building it is a read ---"

check "the scope is inbox, unread and carrying IL/processed, with no cap" \
    "$(order_check 'Only **unread inbox messages that carry `IL/processed`**' \
        'Archived mail and read mail are out of scope' \
        'There is **no message limit**')" "True"
check "the canonical scope query and the per-message recheck" \
    "$(order_check 'in:inbox is:unread label:<IL/processed id>' \
        'pick out the messages that are in the inbox, unread and carry `IL/processed`' \
        'check every message and skip the ones that do not qualify')" "True"
check "producing the overview mutates nothing, and UNREAD is the one write" \
    "$(order_check 'Producing the overview is a read' \
        'The one thing this skill ever writes to Gmail is clearing `UNREAD`')" "True"
check "it runs only when asked, and nothing chains into it" \
    "$(order_check 'Run this only when the user asks for it' \
        'neither processing nor attention may chain into it on its own initiative')" "True"

echo
echo "--- the three sides, and what each is told ---"

check "Gmail holds the messages, the MCP holds the model, the agent holds the mapping" \
    "$(order_check '**Gmail** knows the messages' \
        'It is given **label texts and nothing else**' \
        '**You** hold the mapping between the two, and you keep it')" "True"

echo
echo "--- the representative label is delegated, not judged ---"

check "the ranking is the tool's, called once per batch, positionally aligned" \
    "$(order_check 'The representative label is not yours to choose' \
        'settled by `get_representative_labels`, and that is the only thing that settles it' \
        'do not work the ranking out yourself' \
        'One entry per email, **answered in the same order**')" "True"
check "determinism is stated with the ranking time in it" \
    "$(order_check 'the same current model, the same history and the same ranking time')" "True"
check "the answer is the three fields, and no more" \
    "$(order_check '| `representative` |' '| `secondary` |' '| `unknown` |')" "True"

echo
echo "--- grouping: one row each, and the two terminal sections ---"

check "the presentation principle heads the section it names" \
    "$(order_check 'The label provides the meaning. The row provides the facts.' \
        'shown **exactly once**, under the one label that represents it, as one compact row')" "True"
check "the row extracts facts and neither summarises nor explains" \
    "$(order_check 'do **not** summarise the email, and do **not** explain the label')" "True"
check "icons decide nothing, and an example never licenses a label" \
    "$(order_check 'Icons are presentation only' \
        'Never invent a label because an example used one')" "True"
check "headings are the exact label text" \
    "$(order_check 'headed with the **exact label text**')" "True"
check "sections are ordered by size, then heading, and never by the ranking" \
    "$(order_check 'Order sections by how many emails they hold, most first, then by heading text ascending' \
        'Section order is a count, never the ranking that chose the headings')" "True"
check "unknown-label mail and no-match mail are different terminal sections" \
    "$(order_check 'neither is an Inbox Labeler label' \
        '**`Unknown labels`** — the message carries business labels, but this account defines none of them any more' \
        '**`No match`** — the message carries no business label at all')" "True"
check "a known representative keeps the message out of both, however many unknowns it has" \
    "$(order_check 'however many `unknown` labels it also carries')" "True"

echo
echo "--- secondary labels ---"

check "every secondary-label rule is stated, in order" \
    "$(order_check 'show all of them, and **preserve the exact stored label text**' \
        'never show the representative label again among them' \
        'never show `IL/processed` or `IL/no-match`' \
        'never let a secondary label affect grouping' \
        'never hide a detection label because it fed the derived label in the heading')" "True"

echo
echo "--- step zero: an empty model is not a reason to stop ---"

check "get_labels is called first, and an empty list continues" \
    "$(order_check 'Call `get_labels`' \
        'It returns labels, or an empty list' \
        'Either way, **continue.**' \
        'An empty model does not mean there is no processed mail')" "True"
check "a failed call stops the run and is reported verbatim" \
    "$(order_check 'The call fails' 'Report the error verbatim and stop')" "True"
check "step zero comes before the first Gmail step, and the run creates no Gmail label" \
    "$(order_check '## Step zero: reach the MCP server' \
        'Complete [step zero](#step-zero-reach-the-mcp-server)' \
        '**Create nothing here**' \
        'Find candidate threads with `search_threads`')" "True"
check "the labels on the message are read, not reconsidered" \
    "$(order_check 'Read the labels already on the message' \
        'do not reconsider whether a label belongs there' \
        'That is reading for display, not classification')" "True"

echo
echo "--- presenting it: host-generic, and no ids in front of the user ---"

check "the richest interaction the host supports, with a readable fallback" \
    "$(order_check 'Use the richest interaction the current host supports' \
        'not a particular framework, API or widget' \
        'If it cannot, present the overview as readable grouped text')" "True"
check "no Gmail id is ever shown, and the mapping stays with the agent" \
    "$(order_check 'Never show a Gmail message id, and never ask the user to handle one' \
        'Keep the mapping from each visible row to its Gmail message yourself, privately')" "True"
check "the behaviour is the contract, not a protocol of the skill's own" \
    "$(order_check 'this skill does not prescribe how a host implements it' \
        'Do not invent a command grammar')" "True"

echo
echo "--- marking read: explicit, exact, and never widened ---"

check "it happens only on an explicit request about the overview in front of the user" \
    "$(order_check 'only after the user explicitly asks for it' \
        'Never on render, never on selection')" "True"
check "exactly the messages identified, resolved by the agent, and UNREAD is all it clears" \
    "$(order_check '**Exactly those** — never the section they sit in, never everything shown' \
        'Clear `UNREAD` on them with `unlabel_message`')" "True"
check "an ambiguous or stale request asks rather than widening" \
    "$(order_check 'ask, and change nothing' \
        'Widening an unclear request to a whole section is the failure this rule exists to prevent')" \
    "True"

echo
echo "--- the labels on the mail, and the boundaries ---"

check "the Gmail labels are left exactly as processing put them" \
    "$(order_check 'It does not reclassify, and it does not backfill' \
        'this run leaves every one of them alone')" "True"
check "the current model may regroup old mail, and that is said plainly" \
    "$(order_check 'reads the model **as it stands now**' \
        'can therefore move an already-labelled message into a different section' \
        'while its Gmail labels do not change at all')" "True"
check "specificity is measured against today's references, and claims nothing more" \
    "$(order_check 'measured against the references it has **today**' \
        'It is not a record of what took part when the message was processed')" "True"
check "every boundary is stated, in order" \
    "$(order_check 'It never classifies' \
        'It never touches an `IL/` label, in either direction' \
        'It never calls `record_matches`' \
        'It never stars, archives, deletes, spams or replies' \
        'It never touches mail without `IL/processed`' \
        'It sends nothing about a message to the MCP server' \
        'One failing message is not a failing run')" "True"

echo
echo "--- what this skill leaves out ---"

check "the ranking is not restated in prose beside the one implementation" \
    "$(grep -ciE 'required_labels|recommended_labels|alphabetical|rarer|rarity|matches per day' "$SKILL")" \
    "0"
check "no host-specific interaction API is named" \
    "$(grep -ciE 'sendPrompt|read-message-ids|window\.openai|tools/call|ui/message|MCP Apps' "$SKILL")" \
    "0"
check "no label is given a hand-set priority" \
    "$(grep -ciE 'overviewPriority|overview_priority|primary label|primary category' "$SKILL")" "0"
check "no classification machinery was carried over" \
    "$(grep -ciE 'derived-label prompt|Detection Results|email_timestamp' "$SKILL")" "0"
check "it writes no Gmail label and no star" \
    "$(grep -cE '\bSTARRED\b|(^|[[:space:]`])label_message' "$SKILL")" "0"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
