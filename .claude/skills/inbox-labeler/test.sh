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

field_of() {  # field_of <index> <field>
    python3 -c "import json;print(json.load(open('labels.json'))[$1]['$2'])"
}
id_of() {     # id_of <index>
    field_of "$1" id
}

echo "--- storage bootstrap ---"
ok "list creates an empty store" -- list
check "store starts empty" "$(cat labels.json)" "[]"
check "the store is labels.json" "$(ls labels.json)" "labels.json"

echo
echo "--- create persists type: detection ---"
ok "create without --type" -- create --name "Invoice" --label "Invoice" \
    --instruction "The message is an invoice."
check "type defaults to detection" "$(field_of 0 type)" "detection"
ok "create with explicit --type detection" -- create --name "News" --label "News" \
    --type detection --instruction "Newsletters."
check "explicit type persisted" "$(field_of 1 type)" "detection"
ok "type is case-insensitive" -- create --name "Cased" --label "Cased" \
    --type "Detection" --instruction "x"
check "type normalised to lowercase" "$(field_of 2 type)" "detection"
ok "cleanup cased" -- delete "$(id_of 2)"
check "field order is id, name, label, type, instruction" \
    "$(python3 -c "import json;print(','.join(json.load(open('labels.json'))[0]))")" \
    "id,name,label,type,instruction"

echo
echo "--- list and get expose the type ---"
check "list exposes type" \
    "$(python3 labels.py list | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["type"])')" \
    "detection"
ok "get by id" -- get "$(id_of 0)"
check "get exposes type" \
    "$(python3 labels.py get "$(id_of 0)" | python3 -c 'import json,sys;print(json.load(sys.stdin)["type"])')" \
    "detection"
check "get returns the right label" \
    "$(python3 labels.py get "$(id_of 0)" | python3 -c 'import json,sys;print(json.load(sys.stdin)["name"])')" \
    "Invoice"
err "get by name is rejected" -- get Invoice
err "get with an unknown id" -- get deadbeef

echo
echo "--- update preserves or validates the type ---"
ok "update instruction only" -- update "$(id_of 0)" --instruction "An invoice or bill."
check "type preserved through update" "$(field_of 0 type)" "detection"
ok "update the type explicitly" -- update "$(id_of 0)" --type detection
check "type still detection" "$(field_of 0 type)" "detection"
err "update to an unknown type" -- update "$(id_of 0)" --type bucket
check "store unchanged after a rejected update" "$(field_of 0 type)" "detection"
ok "update accepts --type alone as a change" -- update "$(id_of 0)" --type Detection
err "detection cannot become derived" -- update "$(id_of 1)" --type derived
check "the rejected label is still detection" "$(field_of 1 type)" "detection"
check "and keeps its detection shape" \
    "$(python3 -c "import json;print(','.join(json.load(open('labels.json'))[1]))")" \
    "id,name,label,type,instruction"

echo
echo "--- unknown types are rejected ---"
err "create --type bucket" -- create --name "B" --label "B" --type bucket --instruction "x"
err "create --type empty" -- create --name "E" --label "E" --type "" --instruction "x"
err "create --type nonsense" -- create --name "N" --label "N" --type "detektion" --instruction "x"
check "supported types are exactly detection, derived" \
    "$(python3 -c 'import labels;print(",".join(sorted(labels.LABEL_TYPES)))')" "derived,detection"

echo
echo "--- derived labels: create ---"
ok "create a derived label" -- create --name "LargePayment" --label "LargePayment" \
    --type derived --instruction "A large payment that needs attention." \
    --required-label "Invoice" --recommended-label "News"
check "type is derived" "$(field_of 2 type)" "derived"
check "required_labels stored" \
    "$(python3 -c "import json;print(json.load(open('labels.json'))[2]['required_labels'])")" \
    "['Invoice']"
check "recommended_labels stored" \
    "$(python3 -c "import json;print(json.load(open('labels.json'))[2]['recommended_labels'])")" \
    "['News']"
check "derived field order" \
    "$(python3 -c "import json;print(','.join(json.load(open('labels.json'))[2]))")" \
    "id,name,label,type,instruction,required_labels,recommended_labels"
check "no extra fields beyond the schema" \
    "$(python3 -c "import json;print(len(json.load(open('labels.json'))[2]))")" "7"
ok "repeatable flags accumulate" -- create --name "Multi" --label "Multi" --type derived \
    --instruction "x" --required-label "Invoice" --required-label "News"
check "both references kept, in order" \
    "$(python3 -c "import json;print(json.load(open('labels.json'))[3]['required_labels'])")" \
    "['Invoice', 'News']"
ok "a derived label may reference nothing" -- create --name "Standalone" --label "Standalone" \
    --type derived --instruction "Interprets the email alone."
check "empty reference lists persist as []" \
    "$(python3 -c "import json;e=json.load(open('labels.json'))[4];print(e['required_labels'],e['recommended_labels'])")" \
    "[] []"
check "list exposes derived labels with their references" \
    "$(python3 labels.py list | python3 -c 'import json,sys;print(json.load(sys.stdin)[2]["required_labels"][0])')" \
    "Invoice"
check "get exposes the derived type" \
    "$(python3 labels.py get "$(id_of 2)" | python3 -c 'import json,sys;print(json.load(sys.stdin)["type"])')" \
    "derived"
ok "cleanup Standalone" -- delete "$(id_of 4)"
ok "cleanup Multi" -- delete "$(id_of 3)"

echo
echo "--- derived labels: reference validation ---"
err "unknown required reference" -- create --name "U1" --label "U1" --type derived \
    --instruction "x" --required-label "DoesNotExist"
err "unknown recommended reference" -- create --name "U2" --label "U2" --type derived \
    --instruction "x" --recommended-label "DoesNotExist"
err "a derived label may not reference a derived label" -- create --name "U3" --label "U3" \
    --type derived --instruction "x" --required-label "LargePayment"
err "detection labels reject --required-label" -- create --name "U4" --label "U4" \
    --instruction "x" --required-label "Invoice"
err "detection labels reject --recommended-label" -- create --name "U5" --label "U5" \
    --instruction "x" --recommended-label "Invoice"
err "derived label still needs an instruction" -- create --name "U6" --label "U6" \
    --type derived --instruction "" --required-label "Invoice"
err "derived label still rejects an IL/ prefix" -- create --name "U7" --label "IL/U7" \
    --type derived --instruction "x"
err "derived label still rejects a reserved label" -- create --name "U8" --label "NoMatch" \
    --type derived --instruction "x"
ok "references resolve case-insensitively" -- create --name "Cased" --label "Cased" \
    --type derived --instruction "x" --required-label "invoice"
check "reference stored with the target's spelling" \
    "$(python3 -c "import json;print(json.load(open('labels.json'))[3]['required_labels'])")" \
    "['Invoice']"
ok "duplicate references collapse" -- update "$(id_of 3)" --required-label "Invoice" \
    --required-label "invoice"
check "duplicates removed" \
    "$(python3 -c "import json;print(json.load(open('labels.json'))[3]['required_labels'])")" \
    "['Invoice']"
ok "cleanup Cased" -- delete "$(id_of 3)"

echo
echo "--- derived labels: update ---"
ok "update the instruction" -- update "$(id_of 2)" --instruction "A large payment needing action."
check "type preserved" "$(field_of 2 type)" "derived"
check "references preserved" \
    "$(python3 -c "import json;print(json.load(open('labels.json'))[2]['required_labels'])")" \
    "['Invoice']"
ok "replace the required list" -- update "$(id_of 2)" --required-label "News"
check "list replaced, not appended" \
    "$(python3 -c "import json;print(json.load(open('labels.json'))[2]['required_labels'])")" \
    "['News']"
ok "clear a list with an empty value" -- update "$(id_of 2)" --required-label ""
check "list cleared" \
    "$(python3 -c "import json;print(json.load(open('labels.json'))[2]['required_labels'])")" "[]"
err "update to an unknown reference" -- update "$(id_of 2)" --required-label "DoesNotExist"
check "store unchanged after a rejected update" \
    "$(python3 -c "import json;print(json.load(open('labels.json'))[2]['required_labels'])")" "[]"
ok "restore the reference" -- update "$(id_of 2)" --required-label "Invoice"

echo
echo "--- label types are immutable ---"
err "derived cannot become detection" -- update "$(id_of 2)" --type detection
check "the derived label is untouched" "$(field_of 2 type)" "derived"
check "its references survive the rejection" \
    "$(python3 -c "import json;print(json.load(open('labels.json'))[2]['required_labels'])")" \
    "['Invoice']"
err "derived cannot become an unknown type either" -- update "$(id_of 2)" --type bucket
ok "restating the same type is allowed" -- update "$(id_of 2)" --type derived
ok "so is restating it in another casing" -- update "$(id_of 2)" --type "Derived"
check "still derived" "$(field_of 2 type)" "derived"

echo
echo "--- referenced detection labels cannot be deleted ---"
err "delete a required detection label" -- delete "$(id_of 0)"
check "the referenced label is still there" "$(field_of 0 name)" "Invoice"
check "the store still holds three labels" \
    "$(python3 -c "import json;print(len(json.load(open('labels.json'))))")" "3"
ok "add a recommended reference" -- update "$(id_of 2)" --recommended-label "News"
err "delete a recommended detection label" -- delete "$(id_of 1)"
check "the recommended label is still there" "$(field_of 1 name)" "News"
ok "drop the recommended reference again" -- update "$(id_of 2)" --recommended-label ""
ok "an unreferenced detection label can still be deleted" -- create --name "Loose" \
    --label "Loose" --instruction "Not referenced by anything."
ok "deleting it works" -- delete "$(id_of -1)"
ok "a derived label itself is always deletable" -- create --name "Temp" --label "Temp" \
    --type derived --instruction "x" --required-label "Invoice"
ok "deleting the derived label works" -- delete "$(id_of -1)"

# A throwaway pair, so removing a reference can be shown to unblock the delete
# without disturbing the fixtures the later groups rely on.
ok "create a throwaway detection label" -- create --name "Fleeting" --label "Fleeting" \
    --instruction "Temporary."
ok "create a derived label requiring it" -- create --name "Holder" --label "Holder" \
    --type derived --instruction "x" --required-label "Fleeting"
err "the throwaway is now protected" -- delete "$(id_of 3)"
ok "dropping the reference unblocks it" -- update "$(id_of 4)" --required-label ""
ok "now the throwaway deletes" -- delete "$(id_of 3)"
ok "cleanup Holder" -- delete "$(id_of 3)"
check "the original three fixtures are intact" \
    "$(python3 -c "import json;print(','.join(r['name'] for r in json.load(open('labels.json'))))")" \
    "Invoice,News,LargePayment"

echo
echo "--- detection labels are unaffected by the derived type ---"
check "detection labels have no reference fields" \
    "$(python3 -c "import json;print(','.join(json.load(open('labels.json'))[0]))")" \
    "id,name,label,type,instruction"
check "detection label field count is still 5" \
    "$(python3 -c "import json;print(len(json.load(open('labels.json'))[0]))")" "5"
ok "detection create is unchanged" -- create --name "Plain" --label "Plain" \
    --instruction "Still just an instruction."
check "new detection label has no lists" \
    "$(python3 -c "import json;print(','.join(json.load(open('labels.json'))[3]))")" \
    "id,name,label,type,instruction"
ok "cleanup Plain" -- delete "$(id_of 3)"
check "a derived label does not become a detection label on update" "$(field_of 2 type)" "derived"

echo
echo "--- processing order: detection, then IL/NoMatch, then derived, then IL/Processed ---"
check "detection is the default type" \
    "$(python3 -c 'import labels;print(labels.DEFAULT_TYPE)')" "detection"
check "only derived declares references" \
    "$(python3 -c 'import labels;print(",".join(sorted(t for t,s in labels.LABEL_TYPES.items() if s["references"])))')" \
    "derived"
# The processing order lives in SKILL.md, so assert the documented sequence there.
order_check() {  # order_check <marker> ... -> True when each follows the previous one
    SKILL="$SCRIPT_DIR/SKILL.md" python3 - "$@" <<'PY'
import os, sys
text = open(os.environ["SKILL"], encoding="utf-8").read()
start = 0
for marker in sys.argv[1:]:
    index = text.find(marker, start)
    if index < 0:
        print("OUT OF ORDER OR MISSING: %s" % marker)
        raise SystemExit
    start = index + 1
print(True)
PY
}
check "process: detection -> IL/NoMatch -> derived -> IL/Processed" \
    "$(order_check \
        '### process' \
        '**Detection stage.**' \
        'apply `IL/NoMatch`' \
        '**Derived stage.**' \
        'Apply `IL/Processed` last')" \
    "True"
check "reprocess: detection -> IL/NoMatch -> derived -> IL/Processed" \
    "$(order_check \
        '### reprocess' \
        '**Detection stage.**' \
        'apply `IL/NoMatch`' \
        '**Derived stage.**' \
        'Apply `IL/Processed` last')" \
    "True"
check "the derived prompt lists its four inputs in order" \
    "$(order_check \
        '## The derived-label prompt' \
        '**the email**' \
        '**the detection labels that matched**' \
        '**the evidence**' \
        "derived label's instruction")" \
    "True"
check "the derived prompt uses the Email / Detection Results / Task layout" \
    "$(order_check \
        '## The derived-label prompt' \
        '```text' \
        'Email' \
        'Detection Results' \
        'Evidence:' \
        'Task' \
        'Determine whether the following Derived Label applies.' \
        'Label:' \
        'Instruction:' \
        'Answer yes or no and explain briefly.' \
        '```')" \
    "True"
check "the prompt has no generic Question section" \
    "$(grep -c '^Question$' "$SCRIPT_DIR/SKILL.md")" "0"

echo
echo "--- the skill documents how to model a label from a description ---"
check "modelling comes before the CLI guidance list" \
    "$(order_check \
        '### Modelling what the user asked for' \
        'Never ask' \
        'directly in the email' \
        'interpretation of things already recognised' \
        'Run `list` first' \
        'Create the supporting detection labels first' \
        '`required_labels` is an AND gate' \
        '`recommended_labels` is context')" \
    "True"
check "all three worked examples are present, in order" \
    "$(order_check \
        'TravelDisruption        derived' \
        'LargePaymentNeedsAttention  derived' \
        'CommercialOpportunity       derived')" \
    "True"
check "the explain-then-create rule is documented" \
    "$(order_check \
        '#### Say the model out loud when it is more than one label' \
        'Do not wait for approval' \
        'When a single detection label is all it takes')" \
    "True"
check "required_labels gate the derived stage" \
    "$(order_check '**Derived stage.**' 'required_labels' 'did not all match')" "True"

echo
echo "--- labels are stored without the IL/ prefix ---"
check "persisted JSON contains no IL/" "$(grep -c 'IL/' labels.json)" "0"
ok "nested logical labels are allowed" -- create --name "Conn" --label "Social/Connection" \
    --instruction "A connection request."
check "nested label persisted as given" "$(field_of -1 label)" "Social/Connection"
ok "cleanup nested" -- delete "$(id_of -1)"

echo
echo "--- logical labels resolve to Gmail labels ---"
check "Invoice resolves" \
    "$(python3 -c 'import labels;print(labels.gmail_label("Invoice"))')" "IL/Invoice"
check "nested resolves" \
    "$(python3 -c 'import labels;print(labels.gmail_label("Social/Connection"))')" \
    "IL/Social/Connection"
check "reserved logical labels resolve to the system labels" \
    "$(python3 -c 'import labels;print(",".join(sorted(labels.gmail_label(x) for x in labels.RESERVED_LABELS)))')" \
    "IL/NoMatch,IL/Processed"

echo
echo "--- labels beginning with IL/ are rejected ---"
err "create IL/Invoice" -- create --name "A" --label "IL/Invoice" --instruction "x"
err "create il/invoice (case)" -- create --name "A" --label "il/invoice" --instruction "x"
err "create IL/ alone" -- create --name "A" --label "IL/" --instruction "x"
err "update to IL/Invoice" -- update "$(id_of 0)" --label "IL/Invoice"
ok "a label merely containing IL is fine" -- create --name "Build" --label "CI-IL-Build" \
    --instruction "x"
ok "cleanup" -- delete "$(id_of -1)"

echo
echo "--- reserved logical labels are rejected, case-insensitively ---"
err "create Processed" -- create --name "P" --label "Processed" --instruction "x"
err "create NoMatch" -- create --name "N" --label "NoMatch" --instruction "x"
err "create processed (case)" -- create --name "P" --label "processed" --instruction "x"
err "create NOMATCH (case)" -- create --name "N" --label "NOMATCH" --instruction "x"
err "update to Processed" -- update "$(id_of 0)" --label "Processed"
err "update to nomatch (case)" -- update "$(id_of 0)" --label "nomatch"
ok "look-alikes are still allowed" -- create --name "Processing" --label "Processing" \
    --instruction "x"
ok "cleanup look-alike" -- delete "$(id_of -1)"

echo
echo "--- malformed logical labels are rejected ---"
err "leading slash" -- create --name "A" --label "/Invoice" --instruction "x"
err "trailing slash" -- create --name "A" --label "Invoice/" --instruction "x"
err "double slash" -- create --name "A" --label "Social//Connection" --instruction "x"

echo
echo "--- migration: older stores load as detection labels ---"
cat > labels.json <<'JSON'
[
  {"id": "aaaa1111", "name": "Invoices", "label": "Invoices", "instruction": "Invoices."},
  {"id": "bbbb2222", "name": "Social", "label": "IL/Social", "instruction": "Social mail."},
  {"id": "cccc3333", "name": "Login", "label": "il/Login", "instruction": "Sign-in codes."},
  {"id": "dddd4444", "name": "Deep", "label": "IL/IL/Odd", "instruction": "Doubly prefixed."}
]
JSON
loaded() { python3 labels.py list | python3 -c "import json,sys;print(json.load(sys.stdin)[$1]['$2'])"; }
check "typeless entry loads as detection" "$(loaded 0 type)" "detection"
check "every loaded entry is a detection label" \
    "$(python3 labels.py list | python3 -c 'import json,sys;print(len({r["type"] for r in json.load(sys.stdin)}) == 1)')" \
    "True"
check "prefixed label normalised on load" "$(loaded 1 label)" "Social"
check "lowercase prefix normalised on load" "$(loaded 2 label)" "Login"
check "exactly one prefix removed" "$(loaded 3 label)" "IL/Odd"
check "ids preserved in order" \
    "$(python3 labels.py list | python3 -c 'import json,sys;print(",".join(r["id"] for r in json.load(sys.stdin)))')" \
    "aaaa1111,bbbb2222,cccc3333,dddd4444"
check "names preserved" \
    "$(python3 labels.py list | python3 -c 'import json,sys;print(",".join(r["name"] for r in json.load(sys.stdin)))')" \
    "Invoices,Social,Login,Deep"
check "instructions preserved" "$(loaded 0 instruction)" "Invoices."
check "list does not rewrite the store" "$(grep -c '"IL/Social"' labels.json)" "1"
ok "next write persists the migration" -- update cccc3333 --instruction "Sign-in codes only."
check "type persisted by save" "$(field_of 0 type)" "detection"
check "all four entries typed on disk" \
    "$(python3 -c "import json;print(sum(1 for r in json.load(open('labels.json')) if r['type']=='detection'))")" \
    "4"
check "no IL/ left on disk" "$(grep -c 'IL/Social' labels.json)" "0"
check "order preserved on disk" \
    "$(python3 -c "import json;print(','.join(r['id'] for r in json.load(open('labels.json'))))")" \
    "aaaa1111,bbbb2222,cccc3333,dddd4444"

echo
echo "--- save preserves the type ---"
python3 -c "import labels;labels.save_labels(labels.load_labels())"
check "load -> save keeps every type" \
    "$(python3 -c "import json;print(sorted({r['type'] for r in json.load(open('labels.json'))}))")" \
    "['detection']"
check "load -> save keeps the count" \
    "$(python3 -c "import json;print(len(json.load(open('labels.json'))))")" "4"

echo
echo "--- existing CRUD behaviour is intact ---"
rm -f labels.json
ok "create first" -- create --name "Invoice" --label "Invoice" --instruction "An invoice."
ok "create second" -- create --name "News" --label "News" --instruction "Newsletters."
ID=$(id_of 1)
ok "update by id" -- update "$ID" --label "Newsletter"
check "update applied" "$(field_of 1 label)" "Newsletter"
ok "delete by id" -- delete "$ID"
err "update by name is rejected" -- update News --instruction "x"
err "delete by name is rejected" -- delete News
err "unknown id" -- delete deadbeef
err "empty name" -- create --name " " --label "X" --instruction "x"
err "empty label" -- create --name "X" --label " " --instruction "x"
err "empty instruction" -- create --name "X" --label "X" --instruction ""
err "duplicate name" -- create --name "invoice" --label "Dup" --instruction "x"
err "nothing to update" -- update "$(id_of 0)"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
