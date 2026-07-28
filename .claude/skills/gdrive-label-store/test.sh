#!/usr/bin/env bash
# Google Drive Label Store tests. Runs label_store.py in a temporary directory,
# so no real file is ever touched. Drive is not involved: everything here is the
# deterministic half — validation and serialisation.
#
#   ./test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$SCRIPT_DIR/label_store.py" "$WORK/"
cd "$WORK"

pass=0
fail=0

run() {
    local want=$1 desc=$2
    shift 3
    local out rc
    out=$(python3 label_store.py "$@" 2>&1)
    rc=$?
    if [ "$rc" -eq "$want" ]; then
        pass=$((pass + 1)); printf 'PASS  %s\n' "$desc"
    else
        fail=$((fail + 1))
        printf 'FAIL  %s (exit %s, wanted %s)\n      %s\n' "$desc" "$rc" "$want" "$out"
    fi
}
ok()  { run 0 "$@"; }
err() { run 1 "$@"; }

check() {
    if [ "$2" = "$3" ]; then
        pass=$((pass + 1)); printf 'PASS  %s\n' "$1"
    else
        fail=$((fail + 1))
        printf 'FAIL  %s\n      got:    %s\n      wanted: %s\n' "$1" "$2" "$3"
    fi
}

# errors_for <file> — the validation errors, one per line
errors_for() {
    python3 label_store.py validate "$1" 2>/dev/null \
        | python3 -c 'import json,sys;[print(e) for e in json.load(sys.stdin)["errors"]]'
}
# has_error <file> <substring>
has_error() { errors_for "$1" | grep -qF "$2" && echo yes || echo no; }
error_count() { errors_for "$1" | grep -c . ; }

cat > valid.json <<'JSON'
[
  {
    "label": "Invoice",
    "type": "detection",
    "instruction": "The message is an invoice."
  },
  {
    "label": "Large amount",
    "type": "detection",
    "instruction": "Over 100 in any currency."
  },
  {
    "label": "Large payment needs attention",
    "type": "derived",
    "instruction": "Worth a look.",
    "required_labels": [
      "Large amount"
    ],
    "recommended_labels": [
      "Invoice"
    ]
  }
]
JSON

echo "--- a valid document ---"
ok "validate accepts it" -- validate valid.json
check "no errors" "$(error_count valid.json)" "0"
check "the label count is reported" \
    "$(python3 label_store.py validate valid.json | python3 -c 'import json,sys;print(json.load(sys.stdin)["labels"])')" \
    "3"
printf '[]\n' > empty.json
ok "an empty store is valid" -- validate empty.json
check "and reports zero labels" \
    "$(python3 label_store.py validate empty.json | python3 -c 'import json,sys;print(json.load(sys.stdin)["labels"])')" \
    "0"

echo
echo "--- the document must be readable JSON with the expected root ---"
err "a missing file" -- validate nope.json
check "says so plainly" \
    "$(python3 label_store.py validate nope.json | python3 -c 'import json,sys;print("does not exist" in json.load(sys.stdin)["error"])')" \
    "True"
printf '{ not json\n' > broken.json
err "invalid JSON" -- validate broken.json
check "names the parse problem" \
    "$(python3 label_store.py validate broken.json | python3 -c 'import json,sys;print("not valid JSON" in json.load(sys.stdin)["error"])')" \
    "True"
printf '{"labels": []}\n' > object.json
err "an object root" -- validate object.json
check "wants an array" "$(has_error object.json 'must be a JSON array')" "yes"
printf '["a string"]\n' > strings.json
err "a non-object label" -- validate strings.json
check "wants objects" "$(has_error strings.json 'must be a JSON object')" "yes"

echo
echo "--- required properties and field types ---"
printf '[{"type": "detection", "instruction": "x"}]\n' > nolabel.json
err "a label without a label" -- validate nolabel.json
check "reports it" "$(has_error nolabel.json 'label must be a string')" "yes"
printf '[{"label": "  ", "type": "detection", "instruction": "x"}]\n' > blank.json
err "a blank label" -- validate blank.json
check "reports it" "$(has_error blank.json 'label must not be empty')" "yes"
printf '[{"label": "X", "instruction": "x"}]\n' > notype.json
err "a label without a type" -- validate notype.json
check "reports it" "$(has_error notype.json 'type must be a string')" "yes"
printf '[{"label": "X", "type": "bucket", "instruction": "x"}]\n' > badtype.json
err "an unknown type" -- validate badtype.json
check "lists the known types" "$(has_error badtype.json 'unknown type')" "yes"
printf '[{"label": "X", "type": "detection"}]\n' > noinstr.json
err "a label without an instruction" -- validate noinstr.json
printf '[{"label": "X", "type": "detection", "instruction": 42}]\n' > numinstr.json
err "a numeric instruction" -- validate numinstr.json
check "names the wrong type" "$(has_error numinstr.json 'must be a string, not a number')" "yes"
printf '[{"label": "X", "type": "detection", "instruction": "x", "colour": "red"}]\n' > extra.json
err "an unknown property" -- validate extra.json
check "reports it" "$(has_error extra.json "unknown property 'colour'")" "yes"

echo
echo "--- labels identify uniquely, ignoring case ---"
cat > dupes.json <<'JSON'
[{"label": "Invoice", "type": "detection", "instruction": "x"},
 {"label": "invoice", "type": "detection", "instruction": "y"}]
JSON
err "a case-insensitive duplicate" -- validate dupes.json
check "reports the collision" "$(has_error dupes.json 'duplicates')" "yes"
printf '[{"label": " Padded ", "type": "detection", "instruction": "x"}]\n' > padded.json
err "untrimmed whitespace" -- validate padded.json
printf '[{"label": "Two  spaces", "type": "detection", "instruction": "x"}]\n' > doubled.json
err "doubled inner whitespace" -- validate doubled.json
printf '[{"label": "processed", "type": "detection", "instruction": "x"}]\n' > reserved.json
err "a reserved label" -- validate reserved.json
check "reports it as reserved" "$(has_error reserved.json 'reserved')" "yes"
printf '[{"label": "nomatch", "type": "detection", "instruction": "x"}]\n' > reserved2.json
err "the other reserved label" -- validate reserved2.json
printf '[{"label": "IL/Invoice", "type": "detection", "instruction": "x"}]\n' > prefixed.json
err "a namespaced label" -- validate prefixed.json
check "reports the prefix" "$(has_error prefixed.json 'IL/ namespace')" "yes"

echo
echo "--- references between labels ---"
cat > refs.json <<'JSON'
[{"label": "A", "type": "detection", "instruction": "x"},
 {"label": "D", "type": "derived", "instruction": "x",
  "required_labels": ["a"], "recommended_labels": []}]
JSON
ok "a reference resolves case-insensitively" -- validate refs.json
cat > unknownref.json <<'JSON'
[{"label": "D", "type": "derived", "instruction": "x",
  "required_labels": ["Ghost"], "recommended_labels": []}]
JSON
err "a reference to an unknown label" -- validate unknownref.json
check "reports it" "$(has_error unknownref.json 'not a label in this document')" "yes"
cat > recunknown.json <<'JSON'
[{"label": "D", "type": "derived", "instruction": "x",
  "required_labels": [], "recommended_labels": ["Ghost"]}]
JSON
err "an unknown recommended reference" -- validate recunknown.json
cat > detrefs.json <<'JSON'
[{"label": "A", "type": "detection", "instruction": "x"},
 {"label": "B", "type": "detection", "instruction": "x", "required_labels": ["A"]}]
JSON
err "references on a detection label" -- validate detrefs.json
check "reports it" "$(has_error detrefs.json 'applies only to derived labels')" "yes"
cat > missingrefs.json <<'JSON'
[{"label": "D", "type": "derived", "instruction": "x"}]
JSON
err "a derived label without its reference lists" -- validate missingrefs.json
check "both lists are required" "$(error_count missingrefs.json)" "2"
cat > strref.json <<'JSON'
[{"label": "A", "type": "detection", "instruction": "x"},
 {"label": "D", "type": "derived", "instruction": "x",
  "required_labels": "A", "recommended_labels": []}]
JSON
err "a string where an array belongs" -- validate strref.json
check "reports it" "$(has_error strref.json 'must be an array')" "yes"
cat > numref.json <<'JSON'
[{"label": "A", "type": "detection", "instruction": "x"},
 {"label": "D", "type": "derived", "instruction": "x",
  "required_labels": [7], "recommended_labels": []}]
JSON
err "a non-string reference" -- validate numref.json

echo
echo "--- circular dependencies are rejected ---"
cat > cycle2.json <<'JSON'
[{"label": "A", "type": "derived", "instruction": "x",
  "required_labels": ["B"], "recommended_labels": []},
 {"label": "B", "type": "derived", "instruction": "x",
  "required_labels": ["A"], "recommended_labels": []}]
JSON
err "a two-label cycle" -- validate cycle2.json
check "the cycle is named" "$(has_error cycle2.json 'circular dependency')" "yes"
check "and reported only once" "$(errors_for cycle2.json | grep -c 'circular dependency')" "1"
cat > cycle3.json <<'JSON'
[{"label": "A", "type": "derived", "instruction": "x",
  "required_labels": ["B"], "recommended_labels": []},
 {"label": "B", "type": "derived", "instruction": "x",
  "required_labels": ["C"], "recommended_labels": []},
 {"label": "C", "type": "derived", "instruction": "x",
  "required_labels": ["A"], "recommended_labels": []}]
JSON
err "a three-label cycle" -- validate cycle3.json
check "all three appear in the path" \
    "$(errors_for cycle3.json | grep 'circular' | grep -c 'A -> B -> C -> A')" "1"
cat > selfref.json <<'JSON'
[{"label": "A", "type": "derived", "instruction": "x",
  "required_labels": ["A"], "recommended_labels": []}]
JSON
err "a label referencing itself" -- validate selfref.json
check "reported as a cycle" "$(has_error selfref.json 'circular dependency')" "yes"
cat > diamond.json <<'JSON'
[{"label": "A", "type": "detection", "instruction": "x"},
 {"label": "B", "type": "derived", "instruction": "x",
  "required_labels": ["A"], "recommended_labels": []},
 {"label": "C", "type": "derived", "instruction": "x",
  "required_labels": ["A"], "recommended_labels": ["A"]}]
JSON
ok "two labels sharing a target is not a cycle" -- validate diamond.json

echo
echo "--- nothing is silently repaired ---"
before="$(cat dupes.json)"
python3 label_store.py validate dupes.json >/dev/null 2>&1
check "the file is untouched by validation" "$(cat dupes.json)" "$before"
err "format refuses an invalid document" -- format dupes.json
check "and leaves it alone" "$(cat dupes.json)" "$before"
check "and validation still reports it" "$(has_error dupes.json 'duplicates')" "yes"

echo
echo "--- stable, human-readable serialisation ---"
cat > messy.json <<'JSON'
[{"instruction": "x", "type": "derived", "recommended_labels": [], "label": "D",
  "required_labels": ["A"]},
 {"instruction": "y", "label": "A", "type": "detection"}]
JSON
ok "format accepts a valid but disordered document" -- format messy.json
check "properties come out in canonical order" \
    "$(python3 label_store.py format messy.json | python3 -c 'import json,sys;print(",".join(json.load(sys.stdin)[0]))')" \
    "label,type,instruction,required_labels,recommended_labels"
check "it is indented for humans" \
    "$(python3 label_store.py format messy.json | sed -n '3p' | grep -c '^    ')" "1"
check "formatting is stable" \
    "$(python3 label_store.py format messy.json | md5)" \
    "$(python3 label_store.py format messy.json | md5)"
python3 label_store.py format messy.json > once.json
cp once.json twice_in.json
python3 label_store.py format twice_in.json > twice.json
check "and idempotent" "$(md5 -q once.json)" "$(md5 -q twice.json)"
ok "--write rewrites in place" -- format messy.json --write
check "the file is now canonical" "$(md5 -q messy.json)" "$(md5 -q once.json)"

echo
echo "--- scope: this skill knows nothing about Gmail or email ---"
check "no Gmail tool is called" \
    "$(grep -ciE 'search_threads|get_thread|label_message|unlabel_message|list_labels|create_label' "$SCRIPT_DIR/label_store.py")" \
    "0"
check "no email processing logic" \
    "$(grep -ciE 'is:unread|in:inbox|labelIds|effective_attention|policy_actions' "$SCRIPT_DIR/label_store.py")" \
    "0"
check "no Drive tool is called either" \
    "$(grep -ciE 'search_files|download_file|create_file|get_file_metadata' "$SCRIPT_DIR/label_store.py")" \
    "0"
check "no network or Drive calls" \
    "$(grep -ciE 'urllib|requests|http|socket|oauth|credential|token' "$SCRIPT_DIR/label_store.py")" "0"
check "the CLI is just validate and format" \
    "$(python3 label_store.py --help 2>&1 | grep -o '{[a-z,]*}' | head -1)" "{validate,format}"
check "no revision or conflict machinery is left" \
    "$(grep -ciE 'revision|conflict|checksum|sha256|hashlib|stamp' label_store.py)" "0"
check "the canonical location is declared once" \
    "$(python3 -c 'import label_store;print(label_store.WORKSPACE_FOLDER + "/" + label_store.LABELS_FILE)')" \
    "Inbox Labeler/labels.json"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
