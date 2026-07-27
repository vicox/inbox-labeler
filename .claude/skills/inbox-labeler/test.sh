#!/usr/bin/env bash
# Inbox Labeler tests. Runs label_requests.py in a temporary directory, so the
# real label-requests.json is never touched.
#
#   ./test.sh
#
# Prints one line per check and exits non-zero if any of them fails.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$SCRIPT_DIR/label_requests.py" "$WORK/"
cd "$WORK"

pass=0
fail=0

# ok <description> -- <args...>          expect exit 0
# err <description> -- <args...>         expect exit 1
run() {
    local want=$1 desc=$2
    shift 3  # drop want, desc, and the literal --
    local out rc
    out=$(python3 label_requests.py "$@" 2>&1)
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

label_of() {  # label_of <index>
    python3 -c "import json;print(json.load(open('label-requests.json'))[$1]['label'])"
}
id_of() {     # id_of <index>
    python3 -c "import json;print(json.load(open('label-requests.json'))[$1]['id'])"
}

echo "--- storage bootstrap ---"
ok "list creates an empty store" -- list
check "store starts empty" "$(cat label-requests.json)" "[]"

echo
echo "--- labels are stored without the IL/ prefix ---"
ok "create with a logical label" -- create --name "Invoice" --label "Invoice" \
    --instruction "The message is an invoice."
check "persisted label has no prefix" "$(label_of 0)" "Invoice"
check "persisted JSON contains no IL/" "$(grep -c 'IL/' label-requests.json)" "0"
ok "nested logical labels are allowed" -- create --name "Connection" --label "Social/Connection" \
    --instruction "A connection request."
check "nested label persisted as given" "$(label_of 1)" "Social/Connection"

echo
echo "--- logical labels resolve to Gmail labels ---"
check "Invoice resolves" \
    "$(python3 -c 'import label_requests as l;print(l.gmail_label("Invoice"))')" "IL/Invoice"
check "nested resolves" \
    "$(python3 -c 'import label_requests as l;print(l.gmail_label("Social/Connection"))')" \
    "IL/Social/Connection"
check "reserved logical labels resolve to the system labels" \
    "$(python3 -c 'import label_requests as l;print(",".join(sorted(l.gmail_label(x) for x in l.RESERVED_LABELS)))')" \
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
ok "NoMatches is still allowed" -- create --name "NoMatches" --label "NoMatches" \
    --instruction "x"
ok "cleanup NoMatches" -- delete "$(id_of 3)"
ok "cleanup Processing" -- delete "$(id_of 2)"

echo
echo "--- malformed logical labels are rejected ---"
err "leading slash" -- create --name "A" --label "/Invoice" --instruction "x"
err "trailing slash" -- create --name "A" --label "Invoice/" --instruction "x"
err "double slash" -- create --name "A" --label "Social//Connection" --instruction "x"

echo
echo "--- existing prefixed configuration loads safely ---"
cat > label-requests.json <<'JSON'
[
  {"id": "aaaa1111", "name": "Invoices", "label": "IL/Invoices", "instruction": "Invoices."},
  {"id": "bbbb2222", "name": "Social", "label": "il/Social", "instruction": "Social mail."},
  {"id": "cccc3333", "name": "Login", "label": "Login", "instruction": "Sign-in codes."},
  {"id": "dddd4444", "name": "Deep", "label": "IL/IL/Odd", "instruction": "Doubly prefixed."}
]
JSON
check "prefixed label normalised on load" \
    "$(python3 label_requests.py list | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["label"])')" \
    "Invoices"
check "lowercase prefix normalised on load" \
    "$(python3 label_requests.py list | python3 -c 'import json,sys;print(json.load(sys.stdin)[1]["label"])')" \
    "Social"
check "already-logical label untouched" \
    "$(python3 label_requests.py list | python3 -c 'import json,sys;print(json.load(sys.stdin)[2]["label"])')" \
    "Login"
check "exactly one prefix removed" \
    "$(python3 label_requests.py list | python3 -c 'import json,sys;print(json.load(sys.stdin)[3]["label"])')" \
    "IL/Odd"
check "list does not rewrite the store" "$(grep -c '"IL/Invoices"' label-requests.json)" "1"
ok "next write persists normalised labels" -- update cccc3333 --instruction "Sign-in codes only."
check "normalised store has no IL/Invoices" "$(grep -c '"IL/Invoices"' label-requests.json)" "0"
check "normalised store keeps the logical label" "$(label_of 0)" "Invoices"

echo
echo "--- existing behaviour is intact ---"
rm -f label-requests.json
ok "create first" -- create --name "Invoice" --label "Invoice" --instruction "An invoice."
ok "create second" -- create --name "News" --label "News" --instruction "Newsletters."
ID=$(id_of 1)
ok "update by id" -- update "$ID" --label "Newsletter"
check "update applied" "$(label_of 1)" "Newsletter"
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
