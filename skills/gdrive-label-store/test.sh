#!/usr/bin/env bash
# Google Drive Label Store tests. Runs label_store.py in a temporary directory,
# so no real file is ever touched. Drive is not involved: everything here is the
# deterministic half — validation and serialisation.
#
#   ./test.sh

set -u

# -P: the skill is also reachable through the symlinks in .claude/skills/ and
# .agents/skills/, and the checks against the repository below only find it
# when ".." is followed physically.
SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/../.." && pwd -P)"
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
printf '[{"label": "X", "type": "nonsense", "instruction": "x"}]\n' > badtype.json
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
printf '[{"label": "X", "type": "detection", "attention": "high", "instruction": "x"}]\n' > att.json
ok "a known attention level" -- validate att.json
printf '[{"label": "X", "type": "detection", "attention": "temporary", "instruction": "x"}]\n' > badatt.json
err "an unknown attention level" -- validate badatt.json
check "lists the known levels" "$(has_error badatt.json 'unknown attention')" "yes"
check "the levels mirror the Inbox Labeler's" \
    "$(python3 -c 'import label_store;print(",".join(label_store.ATTENTION_LEVELS))')" \
    "normal,none,high"

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
printf '[{"label": "no-match", "type": "detection", "instruction": "x"}]\n' > reserved2.json
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
# `stamp` used to be in this pattern; matches documents legitimately carry a
# last_matched_at, so it matched data rather than machinery. The names below are
# the machinery itself, including the Drive field newest-wins is decided on —
# which the deterministic half must not know about either.
check "no revision or conflict machinery is left" \
    "$(grep -ciE 'revision|conflict|checksum|sha256|hashlib|modifiedTime|mtime' label_store.py)" "0"
check "the canonical location is declared once" \
    "$(python3 -c 'import label_store;print(label_store.WORKSPACE_FOLDER + "/" + label_store.LABELS_FILE)')" \
    "Inbox Labeler/labels.json"

echo
echo "--- documented behaviour: load reads, save may create the workspace ---"
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
check "the asymmetry is stated up front" \
    "$(order_check 'not symmetric about the workspace folder' \
        'If `Inbox Labeler` is missing' \
        'report that no label definitions were found, and **create nothing**' \
        'create the folder** and carry on, without asking')" \
    "True"
check "load is read-only and creates nothing" \
    "$(order_check '## Load labels' 'Loading never writes anything' \
        'no label definitions were found' 'Do not create it')" "True"
check "save creates the folder when it is missing, without asking" \
    "$(order_check '## Save labels' 'Saving creates the workspace when it has to' \
        'It does not exist' 'create it, without asking' \
        'application/vnd.google-apps.folder' 'do not turn it into a question')" \
    "True"
check "save reuses an existing folder" \
    "$(order_check '## Save labels' 'It exists' 'Never create a second folder of the same name')" \
    "True"
check "several folders is still a question" \
    "$(order_check '## Save labels' 'Several exist' 'stop and ask which one')" "True"
check "the report says whether the folder was created" \
    "$(order_check '## Save labels' 'whether the folder had to be created')" "True"

echo
echo "--- matches documents ---"

# merrors_for <file> — the validation errors for a matches document, one per line
merrors_for() {
    python3 label_store.py validate "$1" --kind matches 2>/dev/null \
        | python3 -c 'import json,sys;[print(e) for e in json.load(sys.stdin)["errors"]]'
}
mhas_error() { merrors_for "$1" | grep -qF "$2" && echo yes || echo no; }
merror_count() { merrors_for "$1" | grep -c . ; }

cat > matches-valid.json <<'JSON'
{
  "Invoices": {
    "last_matched_at": "2026-08-20T10:12:00Z",
    "daily_matches": { "2026-08-18": 2, "2026-08-19": 1, "2026-08-20": 3 }
  },
  "Newsletter": {
    "last_matched_at": "2026-08-20T11:42:00+02:00",
    "daily_matches": { "2026-08-20": 5 }
  }
}
JSON

ok "a matches document validates" -- validate matches-valid.json --kind matches
check "a valid matches document has no errors" "$(merror_count matches-valid.json)" "0"
check "validate reports which kind it checked" \
    "$(python3 label_store.py validate matches-valid.json --kind matches | python3 -c 'import json,sys;print(json.load(sys.stdin)["kind"])')" \
    "matches"
check "the count is the labels with a history" \
    "$(python3 label_store.py validate matches-valid.json --kind matches | python3 -c 'import json,sys;print(json.load(sys.stdin)["labels"])')" \
    "2"

cat > matches-empty.json <<'JSON'
{}
JSON
ok "a matches document with no history at all is valid" -- validate matches-empty.json --kind matches

# A label with no matches yet is a legitimate resting state.
cat > matches-never.json <<'JSON'
{ "Invoices": { "last_matched_at": null, "daily_matches": {} } }
JSON
ok "a label that has never matched is valid" -- validate matches-never.json --kind matches

echo
echo "--- a matches document is counts, never mail ---"
cat > matches-leak.json <<'JSON'
{
  "Invoices": {
    "last_matched_at": "2026-08-20T10:12:00Z",
    "daily_matches": { "2026-08-20": 1 },
    "subject": "Your invoice",
    "message_id": "18f2a1c9",
    "sender": "billing@example.com"
  }
}
JSON
err "a document carrying anything about an email is rejected" -- \
    validate matches-leak.json --kind matches
check "the rejection names every stray property" \
    "$(mhas_error matches-leak.json "'message_id', 'sender', 'subject'")" "yes"
check "the rejection says what the store is for" \
    "$(mhas_error matches-leak.json "nothing about an email")" "yes"

echo
echo "--- matches validation catches the rest ---"
cat > matches-root.json <<'JSON'
[ { "label": "Invoices" } ]
JSON
err "a matches document must not be an array" -- validate matches-root.json --kind matches
check "the wrong root is named as such" \
    "$(mhas_error matches-root.json "must be a JSON object keyed by label")" "yes"

cat > matches-bad-time.json <<'JSON'
{ "Invoices": { "last_matched_at": "2026-08-20T10:12:00", "daily_matches": { "2026-08-20": 1 } } }
JSON
err "a timestamp without an offset is rejected" -- validate matches-bad-time.json --kind matches
check "the timestamp error asks for an offset" \
    "$(mhas_error matches-bad-time.json "with a UTC offset")" "yes"

cat > matches-bad-day.json <<'JSON'
{ "Invoices": { "last_matched_at": null, "daily_matches": { "2026-13-02": 1, "last week": 2 } } }
JSON
err "days that are not dates are rejected" -- validate matches-bad-day.json --kind matches
check "both bad days are reported, not just the first" \
    "$(merror_count matches-bad-day.json)" "2"

cat > matches-bad-count.json <<'JSON'
{ "Invoices": { "last_matched_at": null, "daily_matches": { "2026-08-20": 0, "2026-08-19": "3" } } }
JSON
err "a zero or non-numeric count is rejected" -- validate matches-bad-count.json --kind matches
check "a stored zero is called out" \
    "$(mhas_error matches-bad-count.json "a day with no matches is not stored")" "yes"

cat > matches-reserved.json <<'JSON'
{ "processed": { "last_matched_at": null, "daily_matches": { "2026-08-20": 1 } } }
JSON
err "a reserved label is rejected" -- validate matches-reserved.json --kind matches

cat > matches-prefixed.json <<'JSON'
{ "IL/Invoices": { "last_matched_at": null, "daily_matches": { "2026-08-20": 1 } } }
JSON
err "an IL/ prefixed label is rejected" -- validate matches-prefixed.json --kind matches

echo
echo "--- the two kinds do not cross ---"
check "checking a matches file as labels reports the shape, not nonsense" \
    "$(has_error matches-valid.json "must be a JSON array of labels")" "yes"
check "checking a labels file as matches reports the shape, not nonsense" \
    "$(mhas_error valid.json "must be a JSON object keyed by label")" "yes"
check "kind defaults to labels, so existing calls are unchanged" \
    "$(python3 label_store.py validate valid.json | python3 -c 'import json,sys;print(json.load(sys.stdin)["kind"])')" \
    "labels"

echo
echo "--- matches serialisation is stable ---"
cat > matches-messy.json <<'JSON'
{
  "newsletter": { "daily_matches": { "2026-08-20": 5, "2026-08-01": 1 }, "last_matched_at": "2026-08-20T11:42:00Z" },
  "Invoices": { "daily_matches": { "2026-08-19": 1 }, "last_matched_at": "2026-08-19T09:00:00Z" }
}
JSON
check "labels come out alphabetically, ignoring case" \
    "$(python3 label_store.py format matches-messy.json --kind matches | python3 -c 'import json,sys;print(",".join(json.load(sys.stdin)))')" \
    "Invoices,newsletter"
check "days come out oldest first" \
    "$(python3 label_store.py format matches-messy.json --kind matches | python3 -c 'import json,sys;print(",".join(json.load(sys.stdin)["newsletter"]["daily_matches"]))')" \
    "2026-08-01,2026-08-20"
check "last_matched_at comes before the counts" \
    "$(python3 label_store.py format matches-messy.json --kind matches | python3 -c 'import json,sys;print(",".join(json.load(sys.stdin)["Invoices"]))')" \
    "last_matched_at,daily_matches"
check "formatting a matches document is idempotent" \
    "$(python3 label_store.py format matches-messy.json --kind matches | md5)" \
    "$(python3 label_store.py format matches-messy.json --kind matches | md5)"
err "an invalid matches document is never formatted" -- format matches-leak.json --kind matches

echo
echo "--- both files are documented as the store's contents ---"
check "the workspace holds both files, matches optional" \
    "$(order_check 'Inbox Labeler/' 'labels.json' 'matches.json' \
        '`labels.json` | **required**' '`matches.json` | **optional**')" "True"
check "a missing matches.json is stated to be normal, not a fault" \
    "$(order_check '**`matches.json` may simply not exist**' 'a normal state rather' \
        'never been processed has no history' 'Neither operation below')" "True"
check "the privacy boundary is stated up front" \
    "$(order_check 'holds **counts, never mail**' 'No subject, no sender' \
        'neither needs nor adds any of that')" "True"

check "loading the history follows loading the definitions" \
    "$(order_check '## Load labels' 'Then load the match history' \
        'None in the folder' 'no match history stored yet' 'change nothing' \
        'not an error and not a warning')" "True"
check "a remote history replaces the local one, and that is said plainly" \
    "$(order_check 'Then load the match history' 'the newest is canonical' \
        'replacing what is there' 'A load replaces the local files it found remotely' \
        'lost' 'Save before loading')" "True"
check "an invalid remote history leaves the local one alone" \
    "$(order_check 'Then load the match history' 'Invalid' \
        'leave `data/matches.json` untouched' 'the definitions loaded and the history did')" \
    "True"

check "saving the history follows saving the definitions" \
    "$(order_check '## Save labels' 'Then save the match history, if there is one' \
        'nothing to save' 'no match history to save yet' 'treat the save as complete')" "True"
check "no empty history is invented just to upload one" \
    "$(order_check 'Then save the match history' 'Never invent an empty one')" "True"
check "each file is reported separately, and a half save is not a save" \
    "$(order_check 'Report each file separately' 'name any that were not and why' \
        'stop and report that' 'say exactly that' 'is not a save that worked')" "True"

check "the matches checks are documented" \
    "$(order_check 'And for a matches document' 'root is an object keyed by label' \
        'no property but a last timestamp and a count per day' \
        'days are real calendar dates' 'counts are whole numbers' \
        'privacy boundary made mechanical')" "True"

echo
echo "--- reachable through every skill path ---"
for entry in skills .claude/skills .agents/skills; do
    check "label_store.py runs through $entry/" \
        "$(python3 "$REPO_ROOT/$entry/gdrive-label-store/label_store.py" \
            validate matches-valid.json --kind matches >/dev/null 2>&1 && echo yes)" \
        "yes"
    check "the same document validates the same way through $entry/" \
        "$(python3 "$REPO_ROOT/$entry/gdrive-label-store/label_store.py" \
            validate matches-valid.json --kind matches | python3 -c 'import json,sys;print(json.load(sys.stdin)["ok"])')" \
        "True"
done

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
