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
err "update to an unknown type" -- update "$(id_of 0)" --type derived
check "store unchanged after a rejected update" "$(field_of 0 type)" "detection"
ok "update accepts --type alone as a change" -- update "$(id_of 0)" --type Detection

echo
echo "--- unknown types are rejected ---"
err "create --type derived" -- create --name "D" --label "D" --type derived --instruction "x"
err "create --type bucket" -- create --name "B" --label "B" --type bucket --instruction "x"
err "create --type empty" -- create --name "E" --label "E" --type "" --instruction "x"
err "create --type nonsense" -- create --name "N" --label "N" --type "detektion" --instruction "x"
check "supported types are exactly {detection}" \
    "$(python3 -c 'import labels;print(",".join(sorted(labels.LABEL_TYPES)))')" "detection"

echo
echo "--- labels are stored without the IL/ prefix ---"
check "persisted JSON contains no IL/" "$(grep -c 'IL/' labels.json)" "0"
ok "nested logical labels are allowed" -- create --name "Conn" --label "Social/Connection" \
    --instruction "A connection request."
check "nested label persisted as given" "$(field_of 2 label)" "Social/Connection"
ok "cleanup nested" -- delete "$(id_of 2)"

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
ok "cleanup" -- delete "$(id_of 2)"

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
ok "cleanup look-alike" -- delete "$(id_of 2)"

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
