#!/usr/bin/env bash
# Inbox Labeler tests. Runs labels.py in a temporary directory, so the real
# labels.json is never touched.
#
#   ./test.sh
#
# Prints one line per check and exits non-zero if any of them fails.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$SCRIPT_DIR/labels.py" "$WORK/"
cd "$WORK"

pass=0
fail=0

# ok <description> -- <args...>          expect exit 0
# err <description> -- <args...>         expect exit 1
run() {
    local want=$1 desc=$2
    shift 3  # drop want, desc, and the literal --
    local out rc
    out=$(python3 labels.py "$@" 2>&1)
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
check "fields are label, type, instruction" \
    "$(fields_of "Flight cancellation")" "label,type,instruction"
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
    "label,type,instruction,required_labels,recommended_labels"
check "no extra fields beyond the schema" \
    "$(python3 -c "import json;print(len([e for e in json.load(open('labels.json')) if e['label']=='Travel disruption'][0]))")" \
    "5"
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
    "$(python3 labels.py list | python3 -c 'import json,sys;print(any("name" in e for e in json.load(sys.stdin)))')" \
    "False"
check "list has no id either" \
    "$(python3 labels.py list | python3 -c 'import json,sys;print(any("id" in e for e in json.load(sys.stdin)))')" \
    "False"
ok "get by label text" -- get "Travel disruption"
check "get has no name" \
    "$(python3 labels.py get "Travel disruption" | python3 -c 'import json,sys;print("name" in json.load(sys.stdin))')" \
    "False"
check "get is case-insensitive" \
    "$(python3 labels.py get "TRAVEL DISRUPTION" | python3 -c 'import json,sys;print(json.load(sys.stdin)["label"])')" \
    "Travel disruption"
err "get on an unknown label" -- get "Does not exist"

echo
echo "--- 6. the CLI exposes label, never name ---"
check "create has no --name" \
    "$(python3 labels.py create --help 2>&1 | grep -c -- '--name')" "0"
check "update has no --name" \
    "$(python3 labels.py update --help 2>&1 | grep -c -- '--name')" "0"
check "create takes --label" \
    "$(python3 labels.py create --help 2>&1 | grep -q -- '--label' && echo yes)" "yes"
check "get takes a positional label" \
    "$(python3 labels.py get --help 2>&1 | grep -qi 'label' && echo yes)" "yes"
check "--name is rejected outright by the parser" \
    "$(python3 labels.py create --name "Nope" --label "Nope" --instruction "x" >/dev/null 2>&1; [ $? -ne 0 ] && echo rejected)" \
    "rejected"
check "the module declares no name field" \
    "$(python3 -c 'import labels;print("name" in labels.COMMON_FIELDS)')" "False"
check "the help mentions spaces are fine" \
    "$(python3 labels.py create --help 2>&1 | grep -c 'may contain spaces')" "1"

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
    "IL/nomatch,IL/processed"

echo
echo "--- reserved system labels ---"
check "Gmail uses IL/processed" \
    "$(python3 -c 'import labels;print(labels.gmail_label("processed"))')" "IL/processed"
check "Gmail uses IL/nomatch" \
    "$(python3 -c 'import labels;print(labels.gmail_label("nomatch"))')" "IL/nomatch"
check "the reserved names are lowercase" \
    "$(python3 -c 'import labels;print(",".join(sorted(labels.RESERVED_LABELS)))')" \
    "nomatch,processed"
err "users cannot create processed" -- create --label "processed" --instruction "x"
err "users cannot create nomatch" -- create --label "nomatch" --instruction "x"
err "nor Processed in title case" -- create --label "Processed" --instruction "x"
err "nor NOMATCH shouted" -- create --label "NOMATCH" --instruction "x"
err "nor with padding around it" -- create --label "  processed  " --instruction "x"
ok "a label for the test below" -- create --label "Renameable" --instruction "x"
err "users cannot rename onto processed" -- update "Renameable" --label "processed"
err "users cannot rename onto nomatch, any casing" -- update "Renameable" --label "NoMatch"
check "the rename attempt changed nothing" "$(field "Renameable" label)" "Renameable"
err "users cannot delete processed" -- delete "processed"
err "users cannot delete nomatch" -- delete "nomatch"
check "the error calls it a reserved system label" \
    "$(python3 labels.py delete "processed" 2>&1 | grep -c 'reserved system label')" "1"
check "the create error calls it a reserved system label" \
    "$(python3 labels.py create --label "nomatch" --instruction "x" 2>&1 | grep -c 'reserved system label')" \
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
    "$(python3 labels.py delete "Cancelled flight" 2>&1 | grep -c 'Travel disruption likely')" "1"
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
    "$(python3 labels.py list | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')" \
    "6"
check "no name survives the load" \
    "$(python3 labels.py list | python3 -c 'import json,sys;print(any("name" in e for e in json.load(sys.stdin)))')" \
    "False"
check "no id survives the load" \
    "$(python3 labels.py list | python3 -c 'import json,sys;print(any("id" in e for e in json.load(sys.stdin)))')" \
    "False"
check "a stray IL/ prefix is stripped" \
    "$(python3 labels.py get "LargeAmount" | python3 -c 'import json,sys;print(json.load(sys.stdin)["label"])')" \
    "LargeAmount"
check "a label-less entry falls back to its old name" \
    "$(python3 labels.py get "Legacy" | python3 -c 'import json,sys;print(json.load(sys.stdin)["label"])')" \
    "Legacy"
check "whitespace is normalised" \
    "$(python3 labels.py get "Padded label" | python3 -c 'import json,sys;print(json.load(sys.stdin)["label"])')" \
    "Padded label"
check "a missing type becomes detection" \
    "$(python3 labels.py get "Untyped" | python3 -c 'import json,sys;print(json.load(sys.stdin)["type"])')" \
    "detection"
check "derived references survive" \
    "$(python3 labels.py get "LargePayment" | python3 -c 'import json,sys;print(",".join(json.load(sys.stdin)["required_labels"]))')" \
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
err "the reserved nomatch" -- create --label "nomatch" --instruction "x"
ok "look-alikes are fine" -- create --label "No match found" --instruction "x"
ok "and so is Processing" -- create --label "Processing" --instruction "x"
ok "leading and trailing whitespace is trimmed" -- create --label "  Trimmed  " --instruction "x"
check "stored without the padding" "$(field "Trimmed" label)" "Trimmed"
ok "inner whitespace is collapsed" -- create --label "Two    words" --instruction "x"
check "stored with single spaces" "$(field "Two words" label)" "Two words"
err "a duplicate differing only in whitespace" -- create --label "Two  words" --instruction "x"
err "unknown type" -- create --label "Bucketed" --type bucket --instruction "x"
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

check "process: detection -> IL/nomatch -> derived -> IL/processed" \
    "$(order_check '### process' '**Detection stage.**' 'apply `IL/nomatch`' \
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
check "there is exactly one processing command" \
    "$(order_check 'There is exactly one command' 'process my inbox')" "True"
check "labelling is documented as forward-only" \
    "$(order_check 'Labelling only ever moves forward' 'leaves already-processed mail as it is' \
        'say plainly that it will not')" "True"
check "labelling is documented as add-only" \
    "$(order_check 'Rules while processing' 'Labelling only ever adds' \
        'No label is removed from any message' 'read-only')" "True"
check "nothing removes a label any more" \
    "$(grep -c 'unlabel_message' "$SCRIPT_DIR/SKILL.md")" "0"
check "the readme says nothing is removed" \
    "$(grep -c 'Nothing is ever removed' "$SCRIPT_DIR/../../../README.md")" "1"
check "no reprocess remains in the skill" \
    "$(grep -ci 'reprocess' "$SCRIPT_DIR/SKILL.md")" "0"
check "no reprocess remains in the readme" \
    "$(grep -ci 'reprocess' "$SCRIPT_DIR/../../../README.md")" "0"
check "size alone is still never a reason to stop" \
    "$(order_check 'Rules while processing' 'Never stop for the wrong reason' \
        'Ten messages is the only limit' 'do not sample' 'because the inbox is large')" "True"
check "no stale no-cap claim remains" \
    "$(grep -c 'no cap' "$SCRIPT_DIR/SKILL.md" "$SCRIPT_DIR/../../../README.md" | grep -c ':0$')" "2"
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
    "$(grep -c 'IL/Processed\|IL/NoMatch' "$SCRIPT_DIR/SKILL.md")" "0"
check "the readme has no title-case system labels left" \
    "$(grep -c 'IL/Processed\|IL/NoMatch' "$SCRIPT_DIR/../../../README.md")" "0"
check "the skill does use the lowercase ones" \
    "$(grep -q 'IL/processed' "$SCRIPT_DIR/SKILL.md" && grep -q 'IL/nomatch' "$SCRIPT_DIR/SKILL.md" && echo yes)" \
    "yes"
check "the skill documents the lowercase convention" \
    "$(order_check 'Lowercase is reserved for the system' '`processed` and `nomatch`' \
        'marks them as internal' 'User labels are readable phrases')" "True"
check "the skill calls them reserved system labels" \
    "$(order_check '`processed` and `nomatch` are **reserved system labels**' \
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
    "$(grep -c '"name"' "$SCRIPT_DIR/labels.example.json")" "0"
check "the example store has no id field" \
    "$(grep -c '"id"' "$SCRIPT_DIR/labels.example.json")" "0"
check "the example store uses readable labels" \
    "$(grep -c 'Large payment needs attention' "$SCRIPT_DIR/labels.example.json")" "1"

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
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
