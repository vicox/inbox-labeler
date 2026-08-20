#!/usr/bin/env bash
# Inbox Labeler tests. Runs labels.py against a throwaway copy of the repository
# layout, so the real data/labels.json is never touched.
#
#   ./test.sh
#
# Prints one line per check and exits non-zero if any of them fails.

set -u

# -P throughout: the skill is also reachable through the symlinks in
# .claude/skills/ and .agents/skills/, and the checks against README.md and
# data/ below only find the repository when ".." is followed physically.
SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/../.." && pwd -P)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# labels.py resolves its store as ../../data/labels.json relative to itself, so
# the temporary tree has to mirror skills/inbox-labeler/ and data/ for the store
# to land inside $WORK. Every check below runs from that data directory and
# reads the store as plain labels.json.
mkdir -p "$WORK/skills/inbox-labeler" "$WORK/data"
cp "$SCRIPT_DIR/labels.py" "$SCRIPT_DIR/matches.py" "$WORK/skills/inbox-labeler/"
cd "$WORK/data"
LABELS=../skills/inbox-labeler/labels.py
MATCHES=../skills/inbox-labeler/matches.py
# Checks that import labels as a module run from the data directory too.
export PYTHONPATH="$WORK/skills/inbox-labeler"

pass=0
fail=0

# ok <description> -- <args...>          expect exit 0
# err <description> -- <args...>         expect exit 1
run() {
    local want=$1 desc=$2
    shift 3  # drop want, desc, and the literal --
    local out rc
    out=$(python3 "$LABELS" "$@" 2>&1)
    rc=$?
    if [ "$rc" -eq "$want" ]; then
        pass=$((pass + 1))
        printf 'PASS  %s\n' "$desc"
    else
        fail=$((fail + 1))
        printf 'FAIL  %s (exit %s, wanted %s)\n      %s\n' "$desc" "$rc" "$want" "$out"
    fi
}
ok()  { run 0 "$@"; }
err() { run 1 "$@"; }

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

# field <label> <field>   — read a field of a stored label, by label text
field() {
    python3 - "$1" "$2" <<'PY'
import json, sys
label, field = sys.argv[1], sys.argv[2]
for entry in json.load(open("labels.json")):
    if entry["label"].lower() == label.lower():
        value = entry.get(field, "<missing>")
        print(",".join(value) if isinstance(value, list) else value)
        break
else:
    print("<no such label>")
PY
}
labels_in_store() {
    python3 -c "import json;print(','.join(e['label'] for e in json.load(open('labels.json'))))"
}
fields_of() {
    python3 - "$1" <<'PY'
import json, sys
for entry in json.load(open("labels.json")):
    if entry["label"].lower() == sys.argv[1].lower():
        print(",".join(entry))
        break
PY
}

echo "--- storage bootstrap ---"
ok "list creates an empty store" -- list
check "store starts empty" "$(cat labels.json)" "[]"
check "the store is labels.json" "$(ls labels.json)" "labels.json"

echo
echo "--- 1. a detection label with spaces ---"
ok "create it" -- create --label "Flight cancellation" \
    --instruction "The message says a flight is cancelled."
check "the label keeps its spaces" "$(field "Flight cancellation" label)" "Flight cancellation"
check "type defaults to detection" "$(field "Flight cancellation" type)" "detection"
check "fields are label, type, attention, instruction" \
    "$(fields_of "Flight cancellation")" "label,type,attention,instruction"
ok "another one" -- create --label "Flight delay" \
    --instruction "The message says a flight is delayed."
ok "punctuation is allowed" -- create --label "Won't arrive (probably)" --instruction "x"
ok "so are digits and ampersands" -- create --label "Q3 profit & loss" --instruction "x"
ok "so is a nested label" -- create --label "Travel/Flight" --instruction "x"
ok "cleanup punctuation" -- delete "Won't arrive (probably)"
ok "cleanup digits" -- delete "Q3 profit & loss"
ok "cleanup nested" -- delete "Travel/Flight"

echo
echo "--- 2. a derived label with spaces, 3. + 4. referencing labels with spaces ---"
ok "create it, referencing both ways" -- create --label "Travel disruption" --type derived \
    --instruction "The trip is likely to be disrupted." \
    --required-label "Flight cancellation" --recommended-label "Flight delay"
check "the derived label keeps its spaces" \
    "$(field "Travel disruption" label)" "Travel disruption"
check "required_labels holds the spaced label" \
    "$(field "Travel disruption" required_labels)" "Flight cancellation"
check "recommended_labels holds the spaced label" \
    "$(field "Travel disruption" recommended_labels)" "Flight delay"
check "derived field order" \
    "$(fields_of "Travel disruption")" \
    "label,type,attention,instruction,required_labels,recommended_labels"
check "no extra fields beyond the schema" \
    "$(python3 -c "import json;print(len([e for e in json.load(open('labels.json')) if e['label']=='Travel disruption'][0]))")" \
    "6"
ok "references resolve case-insensitively" -- update "Travel disruption" \
    --required-label "flight cancellation"
check "and are stored with the target's spelling" \
    "$(field "Travel disruption" required_labels)" "Flight cancellation"
err "an unknown spaced reference is rejected" -- create --label "Nope" --type derived \
    --instruction "x" --required-label "Flight cancellation that never was"
err "a derived label may not reference a derived label" -- create --label "Chained" \
    --type derived --instruction "x" --required-label "Travel disruption"
err "detection labels reject --required-label" -- create --label "Plain" --instruction "x" \
    --required-label "Flight delay"

echo
echo "--- 5. list and get expose no name field ---"
check "list has no name" \
    "$(python3 "$LABELS" list | python3 -c 'import json,sys;print(any("name" in e for e in json.load(sys.stdin)))')" \
    "False"
check "list has no id either" \
    "$(python3 "$LABELS" list | python3 -c 'import json,sys;print(any("id" in e for e in json.load(sys.stdin)))')" \
    "False"
ok "get by label text" -- get "Travel disruption"
check "get has no name" \
    "$(python3 "$LABELS" get "Travel disruption" | python3 -c 'import json,sys;print("name" in json.load(sys.stdin))')" \
    "False"
check "get is case-insensitive" \
    "$(python3 "$LABELS" get "TRAVEL DISRUPTION" | python3 -c 'import json,sys;print(json.load(sys.stdin)["label"])')" \
    "Travel disruption"
err "get on an unknown label" -- get "Does not exist"

echo
echo "--- 6. the CLI exposes label, never name ---"
check "create has no --name" \
    "$(python3 "$LABELS" create --help 2>&1 | grep -c -- '--name')" "0"
check "update has no --name" \
    "$(python3 "$LABELS" update --help 2>&1 | grep -c -- '--name')" "0"
check "create takes --label" \
    "$(python3 "$LABELS" create --help 2>&1 | grep -q -- '--label' && echo yes)" "yes"
check "get takes a positional label" \
    "$(python3 "$LABELS" get --help 2>&1 | grep -qi 'label' && echo yes)" "yes"
check "--name is rejected outright by the parser" \
    "$(python3 "$LABELS" create --name "Nope" --label "Nope" --instruction "x" >/dev/null 2>&1; [ $? -ne 0 ] && echo rejected)" \
    "rejected"
check "the module declares no name field" \
    "$(python3 -c 'import labels;print("name" in labels.COMMON_FIELDS)')" "False"
check "the help mentions spaces are fine" \
    "$(python3 "$LABELS" create --help 2>&1 | grep -c 'may contain spaces')" "1"

echo
echo "--- 7. Gmail labels keep the spaces ---"
check "a spaced label resolves" \
    "$(python3 -c 'import labels;print(labels.gmail_label("Delivery arriving soon"))')" \
    "IL/Delivery arriving soon"
check "no underscores or camel case are introduced" \
    "$(python3 -c 'import labels;print("_" in labels.gmail_label("Delivery arriving soon"))')" \
    "False"
check "a nested label resolves" \
    "$(python3 -c 'import labels;print(labels.gmail_label("Travel/Flight delay"))')" \
    "IL/Travel/Flight delay"
check "the reserved labels resolve to the system labels" \
    "$(python3 -c 'import labels;print(",".join(sorted(labels.gmail_label(x) for x in labels.RESERVED_LABELS)))')" \
    "IL/no-match,IL/processed"

echo
echo "--- reserved system labels ---"
check "Gmail uses IL/processed" \
    "$(python3 -c 'import labels;print(labels.gmail_label("processed"))')" "IL/processed"
check "Gmail uses IL/no-match" \
    "$(python3 -c 'import labels;print(labels.gmail_label("no-match"))')" "IL/no-match"
check "the reserved names are lowercase" \
    "$(python3 -c 'import labels;print(",".join(sorted(labels.RESERVED_LABELS)))')" \
    "no-match,processed"
err "users cannot create processed" -- create --label "processed" --instruction "x"
err "users cannot create no-match" -- create --label "no-match" --instruction "x"
err "nor Processed in title case" -- create --label "Processed" --instruction "x"
err "nor NO-MATCH shouted" -- create --label "NO-MATCH" --instruction "x"
err "nor with padding around it" -- create --label "  processed  " --instruction "x"
ok "a label for the test below" -- create --label "Renameable" --instruction "x"
err "users cannot rename onto processed" -- update "Renameable" --label "processed"
err "users cannot rename onto no-match, any casing" -- update "Renameable" --label "No-Match"
check "the rename attempt changed nothing" "$(field "Renameable" label)" "Renameable"
err "users cannot delete processed" -- delete "processed"
err "users cannot delete no-match" -- delete "no-match"
check "the error calls it a reserved system label" \
    "$(python3 "$LABELS" delete "processed" 2>&1 | grep -c 'reserved system label')" "1"
check "the create error calls it a reserved system label" \
    "$(python3 "$LABELS" create --label "no-match" --instruction "x" 2>&1 | grep -c 'reserved system label')" \
    "1"
ok "look-alikes are still ordinary labels" -- create --label "Processed orders" --instruction "x"
ok "and so is No match found" -- create --label "No match found" --instruction "x"
ok "cleanup renameable" -- delete "Renameable"
ok "cleanup processed orders" -- delete "Processed orders"
ok "cleanup no match found" -- delete "No match found"

echo
echo "--- 8. renaming updates every reference ---"
ok "rename a referenced detection label" -- update "Flight cancellation" \
    --label "Cancelled flight"
check "the label is renamed" "$(field "Cancelled flight" label)" "Cancelled flight"
check "required_labels followed the rename" \
    "$(field "Travel disruption" required_labels)" "Cancelled flight"
check "the old label is gone" "$(field "Flight cancellation" label)" "<no such label>"
ok "rename one referenced through recommended_labels" -- update "Flight delay" \
    --label "Delayed flight"
check "recommended_labels followed the rename" \
    "$(field "Travel disruption" recommended_labels)" "Delayed flight"
ok "rename the derived label itself" -- update "Travel disruption" \
    --label "Travel disruption likely"
check "it renamed" "$(field "Travel disruption likely" label)" "Travel disruption likely"
check "and kept its references" \
    "$(field "Travel disruption likely" required_labels)" "Cancelled flight"
ok "a rename may only change casing" -- update "Cancelled flight" --label "Cancelled Flight"
check "the new casing is stored" "$(field "cancelled flight" label)" "Cancelled Flight"
check "references picked up the new casing" \
    "$(field "Travel disruption likely" required_labels)" "Cancelled Flight"
ok "rename back" -- update "Cancelled Flight" --label "Cancelled flight"
ok "renaming to the same text is a no-op" -- update "Cancelled flight" --label "Cancelled flight"
check "still one such label" \
    "$(python3 -c "import json;print(sum(1 for e in json.load(open('labels.json')) if e['label']=='Cancelled flight'))")" \
    "1"
ok "an unrelated update leaves references alone" -- update "Cancelled flight" \
    --instruction "The message says a flight is cancelled, full stop."
check "references untouched" \
    "$(field "Travel disruption likely" required_labels)" "Cancelled flight"

echo
echo "--- 9. renaming onto an existing label is rejected ---"
err "rename onto an existing label" -- update "Cancelled flight" --label "Delayed flight"
check "the source label is untouched" "$(field "Cancelled flight" label)" "Cancelled flight"
check "the target label is untouched" "$(field "Delayed flight" label)" "Delayed flight"
err "rename onto an existing label, different casing" -- update "Cancelled flight" \
    --label "DELAYED FLIGHT"
err "creating a duplicate is rejected too" -- create --label "delayed flight" --instruction "x"
check "the store still holds three labels" \
    "$(python3 -c "import json;print(len(json.load(open('labels.json'))))")" "3"

echo
echo "--- 10. deletion guards use the readable labels ---"
err "delete a required detection label" -- delete "Cancelled flight"
check "the error names both labels" \
    "$(python3 "$LABELS" delete "Cancelled flight" 2>&1 | grep -c 'Travel disruption likely')" "1"
check "it is still there" "$(field "Cancelled flight" label)" "Cancelled flight"
err "delete a recommended detection label" -- delete "Delayed flight"
ok "an unreferenced label deletes" -- create --label "Loose end" --instruction "x"
ok "deleting it works" -- delete "Loose end"
ok "the derived label deletes" -- delete "Travel disruption likely"
ok "and then its references delete too" -- delete "Cancelled flight"
ok "cleanup" -- delete "Delayed flight"
check "store is empty again" "$(labels_in_store)" ""

echo
echo "--- 11.-13. migrating a store written by an earlier version ---"
cat > labels.json <<'JSON'
[
  {"id": "aaaa1111", "name": "Invoices", "label": "Invoices", "type": "detection",
   "instruction": "Invoices."},
  {"id": "bbbb2222", "name": "LargeAmount", "label": "IL/LargeAmount", "type": "detection",
   "instruction": "Over 100."},
  {"id": "cccc3333", "name": "Legacy", "type": "detection", "instruction": "No label field."},
  {"id": "dddd4444", "name": "Spaced", "label": "  Padded   label  ", "type": "detection",
   "instruction": "Whitespace everywhere."},
  {"id": "eeee5555", "name": "Untyped", "label": "Untyped", "instruction": "No type field."},
  {"id": "ffff6666", "name": "LargePayment", "label": "LargePayment", "type": "derived",
   "instruction": "Large payment.", "required_labels": ["LargeAmount"],
   "recommended_labels": ["Invoices"]}
]
JSON
check "every label survives the load" \
    "$(python3 "$LABELS" list | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')" \
    "6"
check "no name survives the load" \
    "$(python3 "$LABELS" list | python3 -c 'import json,sys;print(any("name" in e for e in json.load(sys.stdin)))')" \
    "False"
check "no id survives the load" \
    "$(python3 "$LABELS" list | python3 -c 'import json,sys;print(any("id" in e for e in json.load(sys.stdin)))')" \
    "False"
check "a stray IL/ prefix is stripped" \
    "$(python3 "$LABELS" get "LargeAmount" | python3 -c 'import json,sys;print(json.load(sys.stdin)["label"])')" \
    "LargeAmount"
check "a label-less entry falls back to its old name" \
    "$(python3 "$LABELS" get "Legacy" | python3 -c 'import json,sys;print(json.load(sys.stdin)["label"])')" \
    "Legacy"
check "whitespace is normalised" \
    "$(python3 "$LABELS" get "Padded label" | python3 -c 'import json,sys;print(json.load(sys.stdin)["label"])')" \
    "Padded label"
check "a missing type becomes detection" \
    "$(python3 "$LABELS" get "Untyped" | python3 -c 'import json,sys;print(json.load(sys.stdin)["type"])')" \
    "detection"
check "derived references survive" \
    "$(python3 "$LABELS" get "LargePayment" | python3 -c 'import json,sys;print(",".join(json.load(sys.stdin)["required_labels"]))')" \
    "LargeAmount"
check "list does not rewrite the store" "$(grep -c '"name"' labels.json)" "6"
ok "the next write persists the migration" -- update "Invoices" --instruction "Invoices only."
check "no name on disk" "$(grep -c '"name"' labels.json)" "0"
check "no id on disk" "$(grep -c '"id"' labels.json)" "0"
check "instructions survived" "$(field "LargePayment" instruction)" "Large payment."
ok "renaming the referenced label migrates the dependency" -- update "LargeAmount" \
    --label "Large amount"
check "the dependency points at the new name" \
    "$(field "LargePayment" required_labels)" "Large amount"
ok "and the derived label itself" -- update "LargePayment" --label "Large payment needs attention"
check "its references are unchanged by its own rename" \
    "$(field "Large payment needs attention" required_labels)" "Large amount"
check "recommended references too" \
    "$(field "Large payment needs attention" recommended_labels)" "Invoices"
check "nothing was lost" \
    "$(python3 -c "import json;print(len(json.load(open('labels.json'))))")" "6"

echo
echo "--- validation ---"
err "empty label" -- create --label "   " --instruction "x"
err "empty instruction" -- create --label "Something" --instruction ""
err "IL/ prefix" -- create --label "IL/Something" --instruction "x"
err "il/ prefix, lowercase" -- create --label "il/something" --instruction "x"
err "leading slash" -- create --label "/Something" --instruction "x"
err "trailing slash" -- create --label "Something/" --instruction "x"
err "double slash" -- create --label "Some//thing" --instruction "x"
err "the reserved processed" -- create --label "processed" --instruction "x"
err "the reserved no-match" -- create --label "no-match" --instruction "x"
ok "look-alikes are fine" -- create --label "No match found" --instruction "x"
ok "and so is Processing" -- create --label "Processing" --instruction "x"
ok "leading and trailing whitespace is trimmed" -- create --label "  Trimmed  " --instruction "x"
check "stored without the padding" "$(field "Trimmed" label)" "Trimmed"
ok "inner whitespace is collapsed" -- create --label "Two    words" --instruction "x"
check "stored with single spaces" "$(field "Two words" label)" "Two words"
err "a duplicate differing only in whitespace" -- create --label "Two  words" --instruction "x"
err "unknown type" -- create --label "Nonsensical" --type nonsense --instruction "x"
err "nothing to update" -- update "Processing"
err "update an unknown label" -- update "Nothing here" --instruction "x"
err "delete an unknown label" -- delete "Nothing here"
ok "cleanup no match found" -- delete "No match found"
ok "cleanup processing" -- delete "Processing"
ok "cleanup trimmed" -- delete "Trimmed"
ok "cleanup two words" -- delete "Two words"

echo
echo "--- 15. type immutability and reserved behaviour are unchanged ---"
err "detection cannot become derived" -- update "Invoices" --type derived
check "still detection" "$(field "Invoices" type)" "detection"
err "derived cannot become detection" -- update "Large payment needs attention" --type detection
check "still derived" "$(field "Large payment needs attention" type)" "derived"
ok "restating the same type is allowed" -- update "Invoices" --type detection
ok "in any casing" -- update "Invoices" --type "Detection"
check "supported types are exactly detection, derived" \
    "$(python3 -c 'import labels;print(",".join(sorted(labels.LABEL_TYPES)))')" "derived,detection"

echo
echo "--- attention: the field ---"
rm -f labels.json
ok "attention defaults to normal" -- create --label "Invoice" --instruction "x"
check "stored as normal" "$(field "Invoice" attention)" "normal"
ok "receipt, also normal" -- create --label "Receipt" --instruction "x"
ok "none" -- create --label "Newsletter" --attention none --instruction "x"
ok "marketing, also none" -- create --label "Marketing" --attention none --instruction "x"
ok "high" -- create --label "Contract" --attention high --instruction "x"
ok "case-insensitive" -- create --label "Shouty" --attention "HIGH" --instruction "x"
check "normalised to lowercase" "$(field "Shouty" attention)" "high"
ok "cleanup shouty" -- delete "Shouty"
err "an unknown level is rejected" -- create --label "Nope" --attention urgent --instruction "x"
err "temporary is not a level" -- create --label "Nope" --attention temporary --instruction "x"
ok "it can be changed" -- update "Invoice" --attention high
check "the change stuck" "$(field "Invoice" attention)" "high"
ok "and back" -- update "Invoice" --attention normal
check "it survives a rename" \
    "$(python3 "$LABELS" update "Contract" --label "Signed contract" >/dev/null; field "Signed contract" attention)" \
    "high"
ok "rename back" -- update "Signed contract" --label "Contract"

echo
echo "--- attention: the highest-priority level wins ---"
agg() { python3 "$LABELS" attention "$@" | python3 -c 'import json,sys;print(json.load(sys.stdin)["attention"])'; }
check "none + none -> none" "$(agg "Newsletter" "Marketing")" "none"
check "normal + normal -> normal" "$(agg "Invoice" "Receipt")" "normal"
check "normal + none -> none" "$(agg "Invoice" "Newsletter")" "none"
check "high + normal -> high" "$(agg "Contract" "Invoice")" "high"
check "high + none -> high" "$(agg "Contract" "Newsletter")" "high"
check "high + none + normal -> high" "$(agg "Contract" "Newsletter" "Invoice")" "high"
check "no labels -> normal" "$(agg)" "normal"
check "order does not matter for none over normal" "$(agg "Newsletter" "Invoice")" "none"
check "order does not matter for high" "$(agg "Newsletter" "Contract")" "high"
check "lookup is case-insensitive" "$(agg "contract")" "high"
check "an unknown label is reported, not guessed" \
    "$(python3 "$LABELS" attention "Ghost" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["unknown"][0], d["attention"])')" \
    "Ghost normal"
check "the levels are ranked by priority, lowest first" \
    "$(python3 -c 'import labels;print(",".join(labels.ATTENTION_LEVELS))')" \
    "normal,none,high"

echo
echo "--- attention: the fixed policies ---"
check "none marks read after 24h" \
    "$(python3 -c 'import labels;print(labels.ATTENTION_POLICIES["none"]["mark_read_after"])')" "24h"
check "normal has no policy" \
    "$(python3 -c 'import labels;print(labels.ATTENTION_POLICIES["normal"])')" "{}"
check "high just stars" \
    "$(python3 -c 'import labels;print(labels.ATTENTION_POLICIES["high"])')" "{'star': True}"
check "no policy expires" \
    "$(python3 -c 'import labels;print(sum("expires_after" in p for p in labels.ATTENTION_POLICIES.values()))')" \
    "0"
acts() { python3 "$LABELS" policy "$1" --age "$2" | python3 -c 'import json,sys;print(",".join(json.load(sys.stdin)["actions"]))'; }
check "high stars a fresh message" "$(acts high 1h)" "star"
check "high stars, whatever the age" "$(acts high 900d)" "star"
check "starring never marks read" "$(acts high 900d | grep -c mark_read)" "0"
check "normal does nothing, ever" "$(acts normal 900d)" ""
check "none does nothing before 24h" "$(acts none 1h)" ""
check "none marks read after 24h" "$(acts none 30h)" "mark_read"
check "no level ever unstars" \
    "$(for l in none normal high; do for a in 1h 30h 3d 900d; do acts "$l" "$a"; done; done | grep -c unstar)" \
    "0"
check "an unknown level is rejected by the parser" \
    "$(python3 "$LABELS" policy urgent --age 1h >/dev/null 2>&1; [ $? -ne 0 ] && echo rejected)" \
    "rejected"
check "temporary is rejected by the parser too" \
    "$(python3 "$LABELS" policy temporary --age 1h >/dev/null 2>&1; [ $? -ne 0 ] && echo rejected)" \
    "rejected"

echo
echo "--- attention: Gmail label colors ---"
check "every attention level has a configured color" \
    "$(python3 -c 'import labels;print(set(labels.ATTENTION_LEVELS) <= set(labels.ATTENTION_COLORS))')" \
    "True"
check "none is light gray" \
    "$(python3 "$LABELS" color none | python3 -c 'import json,sys;d=json.load(sys.stdin)["color"];print(d["backgroundColor"],d["textColor"])')" \
    "#cccccc #000000"
check "normal is muted yellow" \
    "$(python3 "$LABELS" color normal | python3 -c 'import json,sys;d=json.load(sys.stdin)["color"];print(d["backgroundColor"],d["textColor"])')" \
    "#fce8b3 #000000"
check "high is muted red" \
    "$(python3 "$LABELS" color high | python3 -c 'import json,sys;d=json.load(sys.stdin)["color"];print(d["backgroundColor"],d["textColor"])')" \
    "#efa093 #000000"
first_color=$(python3 "$LABELS" color high)
second_color=$(python3 "$LABELS" color high)
check "repeated calls return the identical color, so re-sync is idempotent" \
    "$([ "$first_color" = "$second_color" ] && echo same)" "same"
check "reserved system labels are not attention levels, so they never get a color" \
    "$(python3 -c 'import labels;print(any(r in labels.ATTENTION_COLORS for r in labels.RESERVED_LABELS))')" \
    "False"
check "an unknown attention level fails explicitly" \
    "$(python3 - <<'PY'
import labels
try:
    labels.attention_color("urgent")
    print("no error")
except labels.ValidationError:
    print("raised")
PY
)" "raised"
check "a level missing from the color mapping fails explicitly too" \
    "$(python3 - <<'PY'
import labels
labels.ATTENTION_COLORS.pop("normal")
try:
    labels.attention_color("normal")
    print("no error")
except labels.ValidationError:
    print("raised")
PY
)" "raised"
check "an unknown attention is rejected by the color parser" \
    "$(python3 "$LABELS" color urgent >/dev/null 2>&1; [ $? -ne 0 ] && echo rejected)" \
    "rejected"
ok "a detection label at high" -- create --label "Color detection" --attention high \
    --instruction "x"
ok "a derived label at high, referencing it" -- create --label "Color derived" --type derived \
    --attention high --instruction "x" --required-label "Color detection"
check "detection and derived labels resolve to the same color at the same attention" \
    "$(python3 - <<'PY'
import json, labels
entries = {e["label"]: e for e in json.load(open("labels.json"))}
det = labels.attention_color(entries["Color detection"]["attention"])
der = labels.attention_color(entries["Color derived"]["attention"])
print(det == der)
PY
)" "True"
ok "cleanup color derived" -- delete "Color derived"
ok "cleanup color detection" -- delete "Color detection"

echo
echo "--- documented behaviour ---"
order_check() {  # order_check <marker> ... -> True when each follows the previous one
    # Whitespace is collapsed on both sides, so markers survive line rewrapping.
    SKILL="$SCRIPT_DIR/SKILL.md" python3 - "$@" <<'PY'
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
PY
}

check "process: detection -> IL/no-match -> derived -> IL/processed" \
    "$(order_check '### process' '**Detection stage.**' 'apply `IL/no-match`' \
        '**Derived stage.**' 'Apply `IL/processed` last')" "True"
check "the ten-message limit is documented" \
    "$(order_check '### Every run handles at most ten messages' \
        'no more than ten messages' 'Fewer is fine' 'never *which* ones' \
        'never received `IL/processed`, so it is still in scope' \
        'no cursor to keep')" \
    "True"
check "the limit is in the command table" \
    "$(order_check 'Per run' 'process my inbox' 'at most 10')" "True"
check "the process steps stop at ten" \
    "$(order_check '### process' 'stop at ten messages' 'fetch no further page' \
        'count only the ones you actually process against the ten')" "True"
check "a truncated run must be reported as such" \
    "$(order_check '### process' 'If the run stopped at the ten-message limit, say so' \
        'a finished inbox from a truncated run')" "True"
check "the attention command is documented, explicit and label-driven" \
    "$(order_check '### attention' 'Only run this when the user asks' \
        'never part of `process`' 'does not classify anything' \
        'never adds or removes an `IL/` label' \
        'in:inbox is:unread label:<IL/processed id>' \
        'Read the labels already on the message' \
        'Do not evaluate the email' \
        'labels.py attention' 'labels.py policy')" \
    "True"
check "the attention concept precedes the command" \
    "$(order_check '## Attention' 'Attention is not a label' 'highest-priority level' \
        'The policies are fixed, not configurable' '### attention')" "True"
check "the priority order is documented as a rule, not a list" \
    "$(order_check '## Attention' '`high` > `none` > `normal`' \
        'one label at `high` → `high`' 'one label at `none` → `none`' 'otherwise → `normal`' \
        'absence* of a request')" "True"
check "the worked case for none over normal is shown" \
    "$(order_check '`high` > `none` > `normal`' 'labels.py attention "Invoice" "Newsletter"' \
        '{"attention": "none"')" "True"
check "the readme documents the same order" \
    "$(grep -c 'highest-priority one wins\*\* — `high` > `none` > `normal`' "$REPO_ROOT/README.md")" "1"
check "no stale ranking remains" \
    "$(grep -c '`high` > `normal` > `none`' "$SCRIPT_DIR/SKILL.md" "$REPO_ROOT/README.md" | grep -c ':0$')" "2"
check "the three levels and their effects are documented" \
    "$(order_check '## Attention' 'mark_read_after: 24h' 'star: true' \
        'keep it starred')" "True"
check "Gmail label colors follow the policies, ahead of the attention command" \
    "$(order_check 'keep it starred' '### Gmail label colors' '### attention')" "True"
check "colors are documented as presentation, never a second source of truth" \
    "$(order_check '### Gmail label colors' 'presentation only, never a second source of truth')" \
    "True"
check "the mapping is documented as living in one place, unhardcoded elsewhere" \
    "$(order_check '### Gmail label colors' \
        '`ATTENTION_COLORS` in `labels.py` is the one place this mapping lives' \
        'nothing else' 'hardcodes a color')" "True"
check "detection and derived labels are documented as colored identically" \
    "$(order_check '### Gmail label colors' \
        'Detection Labels and Derived Labels are business labels alike' \
        'this applies to both identically')" "True"
check "system labels are documented as excluded from color" \
    "$(order_check '### Gmail label colors' 'this applies to both identically' \
        'never to `IL/processed` or `IL/no-match`' \
        'created and left with no color')" "True"
check "idempotent recoloring is documented" \
    "$(order_check '### Gmail label colors' 'matching already' 'do nothing' \
        'keeps repeated synchronization idempotent')" "True"
check "a color change is documented as never touching a message" \
    "$(order_check '### Gmail label colors' \
        'A color change never touches a message' \
        'it recolors the Gmail label itself')" "True"
check "color failures are documented without rolling back the model change" \
    "$(order_check '### Gmail label colors' \
        'say which Gmail label could not be recolored and continue' \
        'Never undo the label definition or Attention change because a color update failed' \
        'never report synchronization as successful when it was not')" "True"
check "process step 2 creates labels with their attention color" \
    "$(order_check '### process' 'Create any that are missing with `create_label`' \
        'the color from `python3 labels.py color' 'create `IL/processed` and `IL/no-match` with no color')" \
    "True"
check "process step 2 updates color only when it differs, covering Attention changes and Drive loads" \
    "$(order_check '### process' 'compare its current color' \
        'call `update_label` only when they differ' \
        'after its label' 'Attention changed' 'loaded from Drive')" "True"
check "the attention command documents that it never recolors" \
    "$(order_check '### attention' 'no recoloring either' \
        'Gmail label color is synchronized in `process` step 2, never here')" "True"
check "the readme documents attention setting the Gmail label color" \
    "$(grep -c "own Attention also sets its Gmail label's \*\*color\*\*" "$REPO_ROOT/README.md")" \
    "1"
check "the readme documents color as presentation only" \
    "$(grep -c 'Color is purely' "$REPO_ROOT/README.md")" "1"
check "the readme documents message processing never recoloring a message" \
    "$(grep -c 'message processing never recolors a message' "$REPO_ROOT/README.md")" "1"
check "no temporary level remains in the skill" \
    "$(grep -ciE '`temporary`|unstar|expires_after|remove the star' "$SCRIPT_DIR/SKILL.md")" "0"
check "no temporary level remains in the readme" \
    "$(grep -ciE '`temporary`|unstar|expires_after|remove the star' "$REPO_ROOT/README.md")" "0"
check "process and attention are documented as disjoint" \
    "$(order_check 'apply attention' 'The two never overlap' \
        'never part of a `process` run')" "True"
check "the example store shows the levels" \
    "$(python3 -c "import json;print(','.join(sorted({e['attention'] for e in json.load(open('$REPO_ROOT/data/labels.example.json'))})))")" \
    "high,none,normal"
check "there is exactly one processing command" \
    "$(order_check 'There is exactly one command' 'process my inbox')" "True"
check "labelling is documented as forward-only" \
    "$(order_check 'Labelling only ever moves forward' 'leaves already-processed mail as it is' \
        'say plainly that it will not')" "True"
check "process is documented as add-only" \
    "$(order_check 'Rules while processing' 'Labelling only ever adds' \
        '`process` removes no label from any message' \
        'belong to the `attention` command, and to nothing else')" "True"
check "removal appears only in the attention command" \
    "$(grep -c 'unlabel_message' "$SCRIPT_DIR/SKILL.md")" \
    "$(sed -n '/^### attention$/,/^## /p' "$SCRIPT_DIR/SKILL.md" | grep -c 'unlabel_message')"
check "and only for UNREAD" \
    "$(sed -n '/^### attention$/,/^## /p' "$SCRIPT_DIR/SKILL.md" | grep -c 'unlabel_message')" "1"
check "the readme says process only adds labels" \
    "$(grep -c 'only ever adds labels' "$REPO_ROOT/README.md")" "1"
check "no reprocess remains in the skill" \
    "$(grep -ci 'reprocess' "$SCRIPT_DIR/SKILL.md")" "0"
check "no reprocess remains in the readme" \
    "$(grep -ci 'reprocess' "$REPO_ROOT/README.md")" "0"
check "size alone is still never a reason to stop" \
    "$(order_check 'Rules while processing' 'Never stop for the wrong reason' \
        'Ten messages is the only limit' 'do not sample' 'because the inbox is large')" "True"
check "no stale no-cap claim remains" \
    "$(grep -c 'no cap' "$SCRIPT_DIR/SKILL.md" "$REPO_ROOT/README.md" | grep -c ':0$')" "2"
check "the limit is fixed, not configurable" \
    "$(grep -ciE 'configurable limit|--limit|max_messages|batch_size' "$SCRIPT_DIR/SKILL.md")" "0"
check "step zero comes before both commands and covers all five outcomes" \
    "$(order_check '### Step zero: make sure labels are available' \
        'Look locally first' 'Non-empty' 'Empty' \
        'Load from the Google Drive Label Store' \
        'The store reports that no definitions exist' 'Stop.' \
        'The load succeeds' \
        'The load fails for a technical reason' 'Report the error verbatim and stop.')" \
    "True"
check "empty local means not loaded, not no labels" \
    "$(order_check '### Step zero' 'an empty list means *not loaded*, not *no labels exist*')" "True"
check "broken is distinguished from missing" \
    "$(order_check '### Step zero' 'A broken document is not the same as no document' \
        'must never be silently treated as')" "True"
check "process is gated on it" \
    "$(order_check '### process' 'Complete [step zero]')" "True"
check "the ownership boundary is stated in the rules" \
    "$(order_check 'Rules while processing' 'No labels, no processing' \
        'Loading is the store' 'deciding is yours' 'Never put processing rules into it')" "True"
check "the skill defers loading to the store rather than calling Drive" \
    "$(order_check '### Step zero' 'gdrive-label-store' 'Do not reach into Drive yourself')" "True"
check "no Drive tool is named in the inbox labeler skill" \
    "$(grep -ciE 'search_files|download_file_content|create_file\(|get_file_metadata' "$SCRIPT_DIR/SKILL.md")" \
    "0"
check "the derived prompt lists its four inputs in order" \
    "$(order_check '## The derived-label prompt' '**the email**' \
        '**the detection labels that matched**' '**the evidence**' "derived label's instruction")" \
    "True"
check "the derived prompt uses the Email / Detection Results / Task layout" \
    "$(order_check '## The derived-label prompt' '```text' 'Email' 'Detection Results' \
        'Evidence:' 'Task' 'Determine whether the following Derived Label applies.' \
        'Label:' 'Instruction:' 'Answer yes or no and explain briefly.' '```')" "True"
check "the prompt has no generic Question section" \
    "$(grep -c '^Question$' "$SCRIPT_DIR/SKILL.md")" "0"
check "the skill has no title-case system labels left" \
    "$(grep -c 'IL/Processed\|IL/NoMatch\|IL/No-Match' "$SCRIPT_DIR/SKILL.md")" "0"
check "the readme has no title-case system labels left" \
    "$(grep -c 'IL/Processed\|IL/NoMatch\|IL/No-Match' "$REPO_ROOT/README.md")" "0"
check "the skill does use the lowercase ones" \
    "$(grep -q 'IL/processed' "$SCRIPT_DIR/SKILL.md" && grep -q 'IL/no-match' "$SCRIPT_DIR/SKILL.md" && echo yes)" \
    "yes"
check "the skill documents the lowercase convention" \
    "$(order_check 'Lowercase is reserved for the system' '`processed` and `no-match`' \
        'marks them as internal' 'User labels are readable phrases')" "True"
check "the skill calls them reserved system labels" \
    "$(order_check '`processed` and `no-match` are **reserved system labels**' \
        'internal' 'rejects them on create, on rename and on delete')" "True"

echo
echo "--- 14. agent guidance prefers readable labels with spaces ---"
check "the label is documented as the only identifier" \
    "$(order_check '## Labels are identified by their text' 'the only identifier' \
        'no separate name' 'no technical id' 'may contain spaces')" "True"
check "readable phrases are preferred over camel case" \
    "$(order_check '## Labels are identified by their text' 'Delivery arriving soon' \
        'not `DeliveryArrivingSoon`' 'acronym')" "True"
check "renaming is documented as rewriting references" \
    "$(order_check '## Labels are identified by their text' 'Renaming' 'every reference')" "True"
check "case-insensitive uniqueness is documented" \
    "$(order_check '## Labels are identified by their text' 'ignoring case')" "True"
check "the modelling examples read as phrases" \
    "$(order_check '### Modelling what the user asked for' 'Flight cancellation' 'Flight delay' \
        'Travel disruption' 'Large payment needs attention' 'Commercial opportunity')" "True"
check "reuse before creating is documented" \
    "$(order_check '### Modelling what the user asked for' 'Run `list` first' 'Reuse')" "True"
check "one request is not assumed to be one label" \
    "$(order_check '### Modelling what the user asked for' 'how many concepts the request contains' \
        'One request does not imply one label' 'the reuse question')" "True"
check "the reuse question decides both ways" \
    "$(order_check 'the reuse question' 'worth detecting on its own' \
        'model each as its own detection label' 'add a derived label on top' \
        'a single detection label')" "True"
check "the derived label needs its own meaning or behaviour" \
    "$(order_check 'add a derived label on top' 'meaning or behaviour the parts do not')" "True"
check "splitting on mention alone is ruled out" \
    "$(order_check '### Modelling what the user asked for' \
        '**Several concepts mentioned is not a reason to split — several concepts reusable apart is.**' \
        'one detection label models it best' 'simplest model that preserves reuse')" "True"
check "both outcomes are shown as examples" \
    "$(order_check '#### Example: an interpretation over observations that must both hold' \
        '#### Example: several concepts, still one label' 'neither answers the reuse question' \
        'buy no reuse')" "True"
check "the readme says how a request becomes a model" \
    "$(grep -c 'you never pick a type' "$REPO_ROOT/README.md")" "1"
check "and that mention alone does not split a label" \
    "$(grep -c 'being useful apart is' "$REPO_ROOT/README.md")" "1"
check "camel case appears only as the counter-example" \
    "$(grep -cE '\bDeliveryArrivingSoon\b' "$SCRIPT_DIR/SKILL.md")" "1"
check "and that one is shown as what not to write" \
    "$(order_check '`Delivery arriving soon`, not `DeliveryArrivingSoon`')" "True"
check "no other camel-case label examples remain" \
    "$(grep -cE '\b(LargePaymentNeedsAttention|FlightCancellation|FlightDelay|TravelDisruption|LargeAmount|InboundEnquiry|CommercialOpportunity)\b' "$SCRIPT_DIR/SKILL.md")" \
    "0"
check "no --name remains in the skill" \
    "$(grep -c -- '--name' "$SCRIPT_DIR/SKILL.md")" "0"
check "the example store has no name field" \
    "$(grep -c '"name"' "$REPO_ROOT/data/labels.example.json")" "0"
check "the example store has no id field" \
    "$(grep -c '"id"' "$REPO_ROOT/data/labels.example.json")" "0"
check "the example store uses readable labels" \
    "$(grep -c 'Delivery arriving soon' "$REPO_ROOT/data/labels.example.json")" "1"

echo
echo "--- labels are evaluated timelessly ---"
check "the principle has its own section, stated as a rule" \
    "$(order_check '## Labels are timeless' \
        'as if you were reading the email at the moment it was written' \
        'The current date and the current time never influence whether a label applies' \
        'a minute after it lands or five years later' 'never against now')" "True"
check "the worked example is present" \
    "$(order_check '## Labels are timeless' 'Your package will arrive tomorrow.' 'Imminent' \
        'Payment due tomorrow' 'Meeting starts in one hour' 'Flight departs today')" "True"
check "current relevance is named as a separate, later stage" \
    "$(order_check '## Labels are timeless' 'prioritisation, not labelling' \
        'Detection labels and derived labels never make it')" "True"
check "selection is distinguished from evaluation" \
    "$(order_check '## Labels are timeless' 'choosing which messages to look at' \
        'selection, not evaluation')" "True"
check "the processing rules restate it where evaluation happens" \
    "$(order_check 'Rules while processing' 'Judge every message as of the day it was written' \
        'Neither stage consults the current date')" "True"
check "no guidance tells the agent to compare against the current date" \
    "$(grep -ciE "compare .{0,20}(against|to) (today|the current (date|time))|based on (today|the current date)|if (it|the email) is still" "$SCRIPT_DIR/SKILL.md")" \
    "0"

echo
echo "--- match statistics ---"

# mok/merr mirror ok/err, for matches.py rather than labels.py.
mrun() {
    local want=$1 desc=$2
    shift 3
    local out rc
    out=$(python3 "$MATCHES" "$@" 2>&1)
    rc=$?
    if [ "$rc" -eq "$want" ]; then
        pass=$((pass + 1)); printf 'PASS  %s\n' "$desc"
    else
        fail=$((fail + 1))
        printf 'FAIL  %s (exit %s, wanted %s)\n      %s\n' "$desc" "$rc" "$want" "$out"
    fi
}
mok()  { mrun 0 "$@"; }
merr() { mrun 1 "$@"; }

count_for() {  # count_for <label> <day> — that day's count, 0 when absent
    python3 - "$1" "$2" <<'MPY'
import json, os, sys
store = json.load(open("matches.json")) if os.path.exists("matches.json") else {}
print(store.get(sys.argv[1], {}).get("daily_matches", {}).get(sys.argv[2], 0))
MPY
}

last_for() {  # last_for <label> — last_matched_at, "-" when absent
    python3 - "$1" <<'MPY'
import json, os, sys
store = json.load(open("matches.json")) if os.path.exists("matches.json") else {}
print(store.get(sys.argv[1], {}).get("last_matched_at") or "-")
MPY
}

days_for() {  # days_for <label> — the recorded days, oldest first
    python3 - "$1" <<'MPY'
import json, os, sys
store = json.load(open("matches.json")) if os.path.exists("matches.json") else {}
print(",".join(store.get(sys.argv[1], {}).get("daily_matches", {})))
MPY
}

# A policy of its own, so the counts below do not depend on what the earlier
# sections happened to leave behind.
cat > labels.json <<'MJSON'
[
  {"label": "Invoices", "type": "detection", "attention": "normal", "instruction": "an invoice"},
  {"label": "Large amount", "type": "detection", "attention": "normal", "instruction": "a lot"},
  {"label": "Large invoice", "type": "derived", "attention": "high", "instruction": "both",
   "required_labels": ["Invoices", "Large amount"], "recommended_labels": []}
]
MJSON
rm -f matches.json

check "an absent store reads as empty" "$(python3 "$MATCHES" list)" "{}"
check "reading the store creates it" "$(ls matches.json)" "matches.json"

mok "the first match for a label is recorded" -- record --at 2026-08-19T09:00:00Z "Invoices"
check "the first match counts one" "$(count_for Invoices 2026-08-19)" "1"
check "the first match sets last_matched_at" "$(last_for Invoices)" "2026-08-19T09:00:00Z"

mok "a second match on the same day" -- record --at 2026-08-19T17:00:00Z "Invoices"
check "matches on one day accumulate" "$(count_for Invoices 2026-08-19)" "2"
check "a later email that day moves last_matched_at" \
    "$(last_for Invoices)" "2026-08-19T17:00:00Z"

mok "a match on the next day" -- record --at 2026-08-20T10:12:00Z "Invoices"
check "a different day is counted separately" "$(count_for Invoices 2026-08-20)" "1"
check "the earlier day is untouched" "$(count_for Invoices 2026-08-19)" "2"
check "a newer email moves last_matched_at" "$(last_for Invoices)" "2026-08-20T10:12:00Z"

mok "a backfilled email from last year" -- record --at 2025-03-10T12:00:00Z "Invoices"
check "the backfilled day is counted" "$(count_for Invoices 2025-03-10)" "1"
check "a backfilled email does not drag last_matched_at backwards" \
    "$(last_for Invoices)" "2026-08-20T10:12:00Z"
check "days are stored oldest first" \
    "$(days_for Invoices)" "2025-03-10,2026-08-19,2026-08-20"

mok "one email matching three labels" -- \
    record --at 2026-08-20T11:00:00Z "Invoices" "Large amount" "Large invoice"
check "each label of one email is counted independently" \
    "$(count_for Invoices 2026-08-20),$(count_for 'Large amount' 2026-08-20),$(count_for 'Large invoice' 2026-08-20)" \
    "2,1,1"
merr "the same label twice for one email is rejected" -- \
    record --at 2026-08-20T11:00:00Z "Invoices" "invoices"

mok "an offset other than UTC is accepted" -- record --at 2026-08-21T01:30:00+02:00 "Large amount"
check "an offset timestamp counts towards its UTC day" \
    "$(count_for 'Large amount' 2026-08-20)" "2"
check "an offset timestamp is stored as UTC" \
    "$(last_for 'Large amount')" "2026-08-20T23:30:00Z"

merr "a naive timestamp is rejected" -- record --at 2026-08-20T10:12:00 "Invoices"
merr "a timestamp that is not a timestamp is rejected" -- record --at yesterday "Invoices"
merr "an unknown label is rejected" -- record --at 2026-08-20T10:12:00Z "Nope"
check "a rejected record writes nothing" "$(count_for Nope 2026-08-20)" "0"

python3 "$MATCHES" record --at 2026-08-20T12:00:00Z "large AMOUNT" >/dev/null
check "a label is resolved case-insensitively when recording" \
    "$(count_for 'Large amount' 2026-08-20)" "3"

mok "get reads one label" -- get "Invoices"
check "get answers under the spelling labels.json uses" \
    "$(python3 "$MATCHES" get "INVOICES" | python3 -c 'import json,sys;print(",".join(json.load(sys.stdin)))')" \
    "Invoices"
check "list answers with every label that matched" \
    "$(python3 "$MATCHES" list | python3 -c 'import json,sys;print(",".join(sorted(json.load(sys.stdin))))')" \
    "Invoices,Large amount,Large invoice"
merr "get on an unknown label is rejected" -- get "Nope"

ok "a label with history can be renamed" -- update "Invoices" --label "Rechnungen"
check "renaming carries the counts over" "$(count_for Rechnungen 2026-08-19)" "2"
check "renaming keeps last_matched_at" "$(last_for Rechnungen)" "2026-08-20T11:00:00Z"
check "the old name is gone from the match store" "$(count_for Invoices 2026-08-19)" "0"
check "renaming leaves no orphan behind" \
    "$(python3 "$MATCHES" list | python3 -c 'import json,sys;print("Invoices" in json.load(sys.stdin))')" \
    "False"

ok "a label with history can be deleted" -- delete "Large invoice"
check "deleting removes its counts" "$(last_for 'Large invoice')" "-"
check "deleting leaves the other labels alone" "$(count_for Rechnungen 2026-08-19)" "2"

# Path resolution. These run against the real repository and only read: the store
# is asked where it would write, never told to write. Recording here would touch
# the user's own data/matches.json.
store_path() {  # store_path <skill directory> [working directory]
    ( cd "${2:-$REPO_ROOT}" && PYTHONPATH="$1" python3 -c 'import matches; print(matches.STORE)' )
}
for entry in skills .claude/skills .agents/skills; do
    check "the store resolves to data/matches.json through $entry/" \
        "$(store_path "$REPO_ROOT/$entry/inbox-labeler")" "$REPO_ROOT/data/matches.json"
    check "matches.py runs through $entry/" \
        "$(python3 "$REPO_ROOT/$entry/inbox-labeler/matches.py" --help >/dev/null 2>&1 && echo yes)" \
        "yes"
done
check "the store resolves from an unrelated working directory" \
    "$(store_path "$REPO_ROOT/skills/inbox-labeler" /tmp)" "$REPO_ROOT/data/matches.json"

# Structural, not a grep for words: the module names in prose the things it does
# not keep, so the guarantee has to be read off what it actually writes.
check "a stored label carries only a last timestamp and a count per day" \
    "$(python3 - <<'MPY'
import json, re
store = json.load(open("matches.json"))
fields = {field for entry in store.values() for field in entry}
days = {day for entry in store.values() for day in entry["daily_matches"]}
counts = {type(n).__name__ for entry in store.values() for n in entry["daily_matches"].values()}
print(sorted(fields), all(re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) for d in days), sorted(counts))
MPY
)" \
    "['daily_matches', 'last_matched_at'] True ['int']"
check "no day is stored with a count of zero" \
    "$(python3 -c "import json;print(any(n == 0 for e in json.load(open('matches.json')).values() for n in e['daily_matches'].values()))")" \
    "False"
check "the privacy boundary is stated in the module" \
    "$(grep -c 'No part of an email is stored' "$SCRIPT_DIR/matches.py")" "1"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
