#!/usr/bin/env bash
# Hosted Inbox Labeler tests.
#
#   ./test.sh
#
# This skill is the local `inbox-labeler` skill with one change: the labels and
# the match history live in the Inbox Labeler MCP server instead of local files.
# So the tests are the local suite's documented-behaviour checks, adapted where
# storage moved — plus the regression checks for the failure that prompted the
# rebuild, where a run with no unread mail walked backwards into READ messages,
# labelled them and starred them.
#
# There is no CLI to exercise here: `labels.py` and `matches.py` do not exist in
# the hosted arrangement. What can still be protected is that the documented
# behaviour is the old skill's behaviour, so most checks assert the SKILL.md text
# in the same way the local suite does, with the same helper.
#
# Prints one line per check and exits non-zero if any of them fails.

set -u

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/../.." && pwd -P)"
OLD_SKILL="$REPO_ROOT/skills/inbox-labeler/SKILL.md"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

# check <description> <actual> <expected>
check() {
    if [ "$2" = "$3" ]; then
        pass=$((pass + 1))
        printf 'PASS  %s\n' "$1"
    else
        fail=$((fail + 1))
        printf 'FAIL  %s\n      got:    %s\n      wanted: %s\n' "$1" "$2" "$3"
    fi
}

# order_check <marker> ... -> True when each follows the previous one.
# Whitespace is collapsed on both sides, so markers survive line rewrapping.
# Taken from the local skill's suite unchanged, so both skills are checked the
# same way.
order_check() {
    SKILL="$SCRIPT_DIR/SKILL.md" python3 "$WORK/order.py" "$@"
}

# Same, against the local skill — used by the checks that require the two to
# agree, which is the whole premise of this skill.
old_order_check() {
    SKILL="$OLD_SKILL" python3 "$WORK/order.py" "$@"
}

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

cat > "$WORK/colors.py" <<'COLORSPY'
import os, re
labels = open(os.environ["LABELS_PY"], encoding="utf-8").read()
skill = open(os.environ["SKILL_MCP"], encoding="utf-8").read()
mapping = re.search(r"ATTENTION_COLORS = \{(.*?)\}", labels, re.S).group(1)
wanted = re.findall(r"#[0-9a-fA-F]{6}", mapping)
print(bool(wanted) and all(c in skill for c in wanted))
COLORSPY

echo "--- the mail workflow is the old skill's, verbatim ---"
#
# These are the sections the rebuild must not have touched. Rather than restate
# the old skill's wording here, each check asserts the same markers against both
# files: if the hosted skill ever drifts from the local one, the hosted half
# fails while the local half still passes, which says where the fault is.

selection_markers=(
    '### process'
    'search_threads'
    'in:inbox is:unread -label:<IL/processed id>'
    'pageSize: 50'
    'Work through the pages in order, and stop at ten messages'
    'once ten have been processed, stop and fetch no further page'
    'If the pages run out first, you are done — fewer than ten is fine, and so is none'
    'Narrow the query only if the user explicitly asked for a narrower scope'
    'pick out the individual messages that are in the inbox, unread, and lack the `IL/processed` id'
    'check every message and skip the ones that do not qualify'
    'count only the ones you actually process against the ten'
)
check "message selection matches the local skill" \
    "$(order_check "${selection_markers[@]}")" "True"
check "  …and those markers are the local skill's own" \
    "$(old_order_check "${selection_markers[@]}")" "True"

scope_markers=(
    'Only unread inbox messages are ever touched'
    'archived mail and read mail are out of scope in both commands'
    'Unread is only a scope filter'
    'never change the unread state'
    'no marking as read'
    'never treat unread as the processing state'
)
check "the unread/read scope rule matches the local skill" \
    "$(order_check "${scope_markers[@]}")" "True"
check "  …and those markers are the local skill's own" \
    "$(old_order_check "${scope_markers[@]}")" "True"

limit_markers=(
    '### Every run handles at most ten messages'
    'A run processes no more than ten messages, and then stops'
    'Fewer is fine'
    'if none are, it handles none'
    'never *which* ones'
    'never received `IL/processed`, so it is still in scope'
    'no cursor to keep'
)
check "the ten-message limit matches the local skill" \
    "$(order_check "${limit_markers[@]}")" "True"
check "  …and those markers are the local skill's own" \
    "$(old_order_check "${limit_markers[@]}")" "True"

stage_markers=(
    '### process'
    '**Detection stage.**'
    'apply `IL/no-match`'
    '**Derived stage.**'
    'Apply `IL/processed` last'
)
check "the per-message stages match the local skill" \
    "$(order_check "${stage_markers[@]}")" "True"
check "  …and those markers are the local skill's own" \
    "$(old_order_check "${stage_markers[@]}")" "True"

attention_markers=(
    '### attention'
    'Only run this when the user asks'
    'never part of `process`'
    'does not classify anything'
    'never adds or removes an `IL/` label'
    'in:inbox is:unread label:<IL/processed id>'
    'Read the labels already on the message'
    'Do not evaluate the email'
    '`star` → `label_message` with `STARRED`'
    '`mark_read` → `unlabel_message` with `UNREAD`'
)
check "the attention command matches the local skill" \
    "$(order_check "${attention_markers[@]}")" "True"
check "  …and those markers are the local skill's own" \
    "$(old_order_check "${attention_markers[@]}")" "True"

ranking_markers=(
    '## Attention'
    'Attention is not a label'
    '`high` > `none` > `normal`'
    'one label at `high` → `high`'
    'one label at `none` → `none`'
    'otherwise → `normal`'
    'absence* of a request'
    'The policies are fixed, not configurable'
    'mark_read_after: 24h'
    'star: true'
    '### attention'
)
check "the attention ranking and policies match the local skill" \
    "$(order_check "${ranking_markers[@]}")" "True"
check "  …and those markers are the local skill's own" \
    "$(old_order_check "${ranking_markers[@]}")" "True"

prompt_markers=(
    '## The derived-label prompt'
    '**the email**'
    '**the detection labels that matched**'
    '**the evidence**'
    "derived label's instruction"
    'Email'
    'Detection Results'
    'Evidence:'
    'Task'
    'Determine whether the following Derived Label applies.'
    'Answer yes or no and explain briefly.'
)
check "the derived-label prompt matches the local skill" \
    "$(order_check "${prompt_markers[@]}")" "True"
check "  …and those markers are the local skill's own" \
    "$(old_order_check "${prompt_markers[@]}")" "True"

rules_markers=(
    'Rules while processing'
    'No labels, no processing'
    'Detection first, derived second, always'
    'Judge every message as of the day it was written'
    'Every message goes through the full list'
    '`IL/no-match` reflects the detection stage'
    '`IL/processed` is always last and always earned'
    'Labelling only ever adds'
    'Never stop for the wrong reason'
    'Ten messages is the only limit'
    'do not sample'
    'because the inbox is large'
)
check "the processing rules match the local skill" \
    "$(order_check "${rules_markers[@]}")" "True"
check "  …and those markers are the local skill's own" \
    "$(old_order_check "${rules_markers[@]}")" "True"

echo
echo "--- regressions from the observed failure ---"
#
# A run found no unread mail, searched for "unprocessed" inbox mail instead,
# walked backwards into READ messages, classified them, applied IL/processed and
# starred some. Each check below is one link in that chain.

# A. Zero eligible unread messages.
check "A. running out of results ends the run rather than widening it" \
    "$(order_check 'If the pages run out first, you are done — fewer than ten is fine, and so is none')" \
    "True"
check "A. the empty case is named in the limit section too" \
    "$(order_check '### Every run handles at most ten messages' 'if none are, it handles none')" "True"
check "A. nothing licenses a fallback search when the query returns nothing" \
    "$(grep -ciE 'if (no|none|zero|fewer)[^.]{0,60}(broaden|widen|fall back|instead search|drop the)' "$SCRIPT_DIR/SKILL.md")" \
    "0"

# B. Read inbox mail without IL/processed exists and must not be selected.
check "B. the search itself is scoped to unread" \
    "$(order_check 'in:inbox is:unread -label:<IL/processed id>')" "True"
check "B. every message is re-checked for unread before it is processed" \
    "$(order_check 'pick out the individual messages that are in the inbox, unread, and lack the `IL/processed` id')" \
    "True"
check "B. read mail is stated to be out of scope" \
    "$(order_check 'archived mail and read mail are out of scope in both commands')" "True"
check "B. IL/processed alone never defines the scope" \
    "$(grep -ciE 'unprocessed (inbox )?(mail|messages|emails)|messages? without .?IL/processed.? (are|is) (the |in )?scope' "$SCRIPT_DIR/SKILL.md")" \
    "0"

# The two additive exceptions that would re-open the regression. The checks above
# catch a rule being *removed*; these catch one being *added* alongside it, which is
# how the production failure actually read — the scope was still documented, and a
# later sentence licensed going past it.
check "B. nothing licenses continuing into read mail once unread is exhausted" \
    "$(grep -ciE '(exhaust|run out|none left|no more unread|nothing unread|no unread)[^.]{0,90}(read mail|read message|read inbox|already read|previously read)|continue (on )?into read|move on to read (inbox )?(mail|messages)|then (also )?(take|include|process) read|include read (inbox )?(mail|messages|emails)' "$SCRIPT_DIR/SKILL.md")" \
    "0"
check "B. nothing makes the absence of IL/processed sufficient on its own" \
    "$(grep -ciE '(absence|lack) of .?IL/processed.?[^.]{0,30}(enough|sufficient)|without .?IL/processed.?[^.]{0,30}(enough|sufficient)|IL/processed[^.]{0,60}even (when|if)[^.]{0,30}\bread\b|regardless of (whether it is )?\b(read|unread)\b|\bread or unread\b|whether or not it is unread' "$SCRIPT_DIR/SKILL.md")" \
    "0"

# C. "Process my 10 most recent unprocessed inbox emails."
check "C. the limit changes how many, never which" \
    "$(order_check 'The limit changes *how many* messages a run touches, never *which* ones')" "True"
check "C. narrowing is the only user-driven change to the query" \
    "$(order_check 'Narrow the query only if the user explicitly asked for a narrower scope')" "True"
check "C. a short run is reported rather than filled" \
    "$(order_check 'Always say how many you handled and whether more remain')" "True"
check "C. no wording invites filling a batch" \
    "$(grep -ciE 'fill (the|a) batch|to reach ten|until ten|make up the (ten|number)|top up' "$SCRIPT_DIR/SKILL.md")" \
    "0"

# D. Mixed mailbox state — selection is the old skill's, exactly.
check "D. the three per-message conditions are inbox, unread, no IL/processed" \
    "$(order_check 'in the inbox, unread, and lack the `IL/processed` id in `labelIds`')" "True"
check "D. thread results are filtered per message" \
    "$(order_check 'a result can mix in-scope and out-of-scope messages' \
        'check every message and skip the ones that do not qualify')" "True"
check "D. skipped messages do not consume the limit" \
    "$(order_check 'count only the ones you actually process against the ten')" "True"
check "D. processing never changes the unread state" \
    "$(order_check 'never change the unread state' 'no marking as read')" "True"
check "D. starring belongs to the attention command alone" \
    "$(order_check '`STARRED` and `UNREAD` belong to the `attention` command, and to nothing else')" "True"

echo
echo "--- the storage adapter ---"

check "labels are read with get_labels" \
    "$(order_check '### Step zero' '**Call `get_labels`.**' 'That is the store')" "True"
check "an empty list stops the run and is not a starter set" \
    "$(order_check '### Step zero' 'It returns an empty list' '**Stop.**' \
        'offer to create some' 'do not invent a starter set')" "True"
check "a failed call stops the run and is not treated as empty" \
    "$(order_check '### Step zero' 'The call fails' 'Report the error verbatim and stop.' \
        'Do not fall back to an empty list')" "True"
check "broken is still distinguished from missing" \
    "$(order_check '### Step zero' 'must never be silently treated as' 'relabel a mailbox from an empty rulebook')" \
    "True"
check "label CRUD goes through the MCP tools" \
    "$(order_check '## Managing labels' 'get_labels' 'create_label' 'update_label' \
        'new_label' 'delete_label')" "True"
check "matches are recorded with record_matches" \
    "$(order_check '### process' 'record_matches' 'email_timestamp' \
        "The timestamp is the email's own, not the moment you are running")" "True"
check "the history is read with get_matches" \
    "$(grep -c 'get_matches' "$SCRIPT_DIR/SKILL.md")" "1"
check "the two same-named tool sets are disambiguated" \
    "$(order_check 'Two sets of tools share three names' 'confusing them writes to the wrong place')" \
    "True"
check "identity is the authenticated session, never an account id" \
    "$(order_check 'Identity is the authenticated MCP session' 'Never ask the user for an account id')" \
    "True"
check "the attention and colour tables replaced the CLI that computed them" \
    "$(order_check '| `none` | `#cccccc` | `#000000` |' '| `normal` | `#fce8b3` | `#000000` |' \
        '| `high` | `#efa093` | `#000000` |')" "True"
check "the colour values are the local implementation's" \
    "$(LABELS_PY="$REPO_ROOT/skills/inbox-labeler/labels.py" \
        SKILL_MCP="$SCRIPT_DIR/SKILL.md" python3 "$WORK/colors.py")" "True"

echo
echo "--- nothing local survives, and no new vocabulary ---"

# Every concrete obsolete form the port left behind, not just the CLI invocation.
check "no local CLI invocation remains" \
    "$(grep -ciE 'python3 |labels\.py|matches\.py' "$SCRIPT_DIR/SKILL.md")" "0"
check "no local CLI flag syntax remains" \
    "$(grep -coE '\-\-(label|type|instruction|required-label|recommended-label|at) ' "$SCRIPT_DIR/SKILL.md")" "0"
check "no local per-label get syntax remains" \
    "$(grep -ciE '`get [\"]|`get_label`|get_label\b|\bget "[a-z]' "$SCRIPT_DIR/SKILL.md")" "0"
check "no local update/rename command syntax remains" \
    "$(grep -ciE 'update <label>|`update `|`delete `|`list`|`get`, `update` and `delete`' "$SCRIPT_DIR/SKILL.md")" "0"
check "no local storage file is referenced" \
    "$(grep -ciE 'labels\.json|matches\.json|data/|local store|the two files' "$SCRIPT_DIR/SKILL.md")" "0"
check "no CLI-only behaviour claim remains" \
    "$(grep -ciE 'the CLI|only the CLI|CLI rejects|CLI deals' "$SCRIPT_DIR/SKILL.md")" "0"
check "the Drive store is gone" \
    "$(grep -ci 'gdrive-store' "$SCRIPT_DIR/SKILL.md")" "0"
check "no Drive tool is named" \
    "$(grep -ciE 'search_files|download_file_content|create_file\(|get_file_metadata' "$SCRIPT_DIR/SKILL.md")" "0"
check "'policy' is never used beyond the local skill's own usage" \
    "$(test "$(grep -cio 'policy\|policies' "$SCRIPT_DIR/SKILL.md")" -le \
        "$(grep -cio 'policy\|policies' "$OLD_SKILL")" && echo within || echo beyond)" "within"
check "no 'label policy' abstraction was introduced" \
    "$(grep -ciE 'label policy|the policy (is|holds|returns)|policy label' "$SCRIPT_DIR/SKILL.md")" "0"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
