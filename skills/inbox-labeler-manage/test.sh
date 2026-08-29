#!/usr/bin/env bash
# Inbox Labeler manage-skill contract tests.
#
#   ./test.sh
#
# This skill is an extraction from skills/inbox-labeler-mcp/SKILL.md — the label
# half of it and nothing else. The checks here are deliberately few. They are not
# trying to prove every sentence survived; they hold the handful of rules that,
# if they changed, would change what an agent does with somebody's labels, plus
# the responsibility boundary: this skill defines labels, it does not read mail.
#
# The boundary is not held by looking for words. Naming `IL/processed` or
# `UNREAD` is how the skill *states* the boundary — "Manage never applies
# `IL/processed`" is the rule, not a breach of it — while an instruction that
# crosses it ("classify ten messages from the inbox") need not contain any of
# those words at all. So the patterns below match the instruction form: a verb
# telling the agent to do the thing, with a fixed lookbehind for a negator
# standing directly in front of that verb. Every licensing alternative carries
# that guard, and the guard reaches one verb only: "never stars mail, but after
# setup archive messages" still fails, because the negation in front of the
# first verb says nothing about the second. Each pattern is then shown to be
# live against a copy of the skill carrying one contradictory sentence.
#
# Prints one line per check and exits non-zero if any of them fails.

set -u

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
SKILL="$SCRIPT_DIR/SKILL.md"

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

# Whether the skill says something, ignoring how it happens to be line-wrapped.
says() {
    tr '\n' ' ' < "$SKILL" | tr -s ' ' | grep -qiF "$1" && echo yes || echo no
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/licenses.py" <<'PYEOF'
import os, re, sys
# Counts the places one pattern matches in the skill body. No sentence
# splitting and no prohibition exemption: each pattern is written to match the
# instruction itself, so the skill saying it does not do a thing cannot look
# like an instruction to do it.
text = open(os.environ["SKILL"], encoding="utf-8").read()
# The body only. The frontmatter description is metadata, not a rule.
body = text.split("---", 2)[2] if text.startswith("---") else text
flat = re.sub(r"\s+", " ", body)
print(len(re.findall(sys.argv[1], flat, re.I)))
PYEOF

licenses_in() { SKILL="$1" python3 "$WORK/licenses.py" "$2"; }
denies()      { licenses_in "$SKILL" "$1"; }

# Appends one sentence to a *copy* of the skill and reports whether the given
# pattern catches it. Only the pattern under test is run, so a mutation cannot
# look proven by tripping some unrelated check.
with_sentence() { # pattern sentence -> detected|missed
    cp "$SKILL" "$WORK/mutant.md"
    printf '\n%s\n' "$2" >> "$WORK/mutant.md"
    if [ "$(licenses_in "$WORK/mutant.md" "$1")" = "0" ]; then echo missed; else echo detected; fi
    rm -f "$WORK/mutant.md"
}

# Whether any pattern fires on a copy carrying the sentence. Wording that states
# the boundary rather than crossing it has to survive all of them.
none_fire() { # sentence -> clean|<names>
    cp "$SKILL" "$WORK/mutant.md"
    printf '\n%s\n' "$1" >> "$WORK/mutant.md"
    hits=""; i=0
    for pattern in "${PATTERNS[@]}"; do
        [ "$(licenses_in "$WORK/mutant.md" "$pattern")" != "0" ] && hits="$hits ${NAMES[$i]}"
        i=$((i + 1))
    done
    rm -f "$WORK/mutant.md"
    [ -z "$hits" ] && echo clean || echo "tripped:$hits"
}

# Which patterns the skill already matches. All of them describe a
# contradiction, so the answer has to be none.
fires_on_skill() {
    hits=""; i=0
    for pattern in "${PATTERNS[@]}"; do
        [ "$(denies "$pattern")" != "0" ] && hits="$hits ${NAMES[$i]}"
        i=$((i + 1))
    done
    [ -z "$hits" ] && echo none || echo "$hits"
}

# --- the file is a skill ----------------------------------------------------

check 'frontmatter opens at the very first byte' \
    "$(head -c 4 "$SKILL")" "$(printf -- '---\n')"

check 'frontmatter names this skill and closes' \
    "$(awk 'NR>1 && /^---$/ {print NR; exit}' "$SKILL")" "4"

check 'frontmatter carries the name and a description' \
    "$(grep -cE '^(name: inbox-labeler-manage|description: .{40,})$' "$SKILL")" "2"

# --- what a label is --------------------------------------------------------

check 'detection recognises, derived interprets — and they stay distinct' \
    "$(says 'Detection labels recognise facts. Derived labels interpret those facts.')" "yes"

check 'the instruction is the rule a later run applies, not a description' \
    "$(says 'it is the natural-language rule a processing run later applies to a real message')" "yes"

check 'required_labels is an AND gate that decides whether the label is evaluated' \
    "$(says 'every one of them must have matched, or the derived label is not evaluated')$(says 'required_labels` is an AND gate')" "yesyes"

check 'recommended_labels is context, and its absence does not block evaluation' \
    "$(says 'when they did not, the derived label is evaluated anyway')$(says 'recommended_labels` is context')" "yesyes"

check 'derived labels never reference other derived labels' \
    "$(says 'Derived labels never reference other derived labels')" "yes"

# --- what may be written ----------------------------------------------------

check 'existing labels are read before modelling, and reused rather than duplicated' \
    "$(says 'Call `get_labels` first')$(says 'Reuse them instead of creating a near-duplicate')" "yesyes"

check 'a type can never be changed after the label exists' \
    "$(says "A label's type is immutable")$(says "label's type cannot be changed afterwards")" "yesyes"

check 'renaming goes through update_label with new_label and rewrites references' \
    "$(says 'Renaming is `update_label` with `new_label`')$(says 'rewrites every reference to that label')" "yesyes"

check 'processed and no-match are the systems own labels and are refused' \
    "$(says 'own two labels are spelled `processed` and `no-match`')$(says 'rejects them on create, on rename and on delete')" "yesyes"

check 'a stored label never carries the IL/ prefix' \
    "$(says 'it never appears in a stored label')$(says 'rejects anything starting with `IL/`')" "yesyes"

# --- the boundary: this skill defines labels, it does not read mail ---------
#
# Six semantic guards and three runtime ones. Each matches an instruction, not a
# mention: a verb that would make the agent do the thing.

REQUIRED_GATE='required_labels[^.]{0,50}(optional|not required|context, not a gate|may be treated as|any subset|need not)'
RECOMMENDED_CTX='recommended_labels[^.]{0,50}(mandatory|are required|must all|all must|is a gate|are a gate)'
IMMUTABLE_TYPE='\btype\b[^.]{0,40}\b(may|can)\b be changed|chang(e|ed|ing) (a|the|an existing) label.{0,3}s type|\btype\b is \b(mutable|changeable)\b'
NO_CHAINING='derived label[^.]{0,50}\b(may|can)\b reference[^.]{0,40}derived|chaining is (allowed|permitted|supported)'
RENAME_REFS='renam(e|ing)[^.]{0,60}(does not|will not|never) (update|rewrite|change)|references[^.]{0,40}(are not|is not) (updated|rewritten)'
STORED_NAMESPACE='stor(e|ed|ing)[^.]{0,50}(with|including) the .{0,3}IL/|label names? with the .{0,3}IL/ prefix|stored labels? (includes?|carries|contains)[^.]{0,20}IL/'

RUNTIME_MAIL='(?<!never )(?<!not )(?<!or )\b(inspect|inspects|search|searches|scan|scans|fetch|fetches|open|opens)\b[^.]{0,30}\b(inbox|threads?|messages|mail)\b|(?<!never )(?<!not )(?<!or )\b(read|reads|process|processes)\b +((the|your|each|every|all|ten|configured|new|unread|[0-9]+) +)*(inbox|threads?|messages?|mail)\b|(?<!never )(?<!not )(?<!or )\bclassif(y|ies)\b|(?<!never )(?<!not )(?<!or )\b(call|calls|use|uses|run|runs)\b[^.]{0,25}\b(search_threads|get_thread)\b'
RUNTIME_ATTENTION='(?<!never )(?<!not )(?<!or )\b(star|unstar|unstars)\b[^.]{0,30}\b(message|messages|mail|attention)\b|(?<!never )(?<!not )(?<!or )\bmark\b[^.]{0,30}\b(read|unread)\b|(?<!never )(?<!not )(?<!or )\b(archive|archives|delete|deletes|trash|trashes|reply|replies)\b +((the|a|an|each|every|all|old|those) +)*(messages?|mail|threads?|emails?)\b|(?<!never )(?<!not )(?<!or )\b(change|changes|clear|clears|remove|removes|add|adds|set|sets)\b[^.]{0,25}\b(UNREAD|STARRED)\b'
RUNTIME_WRITES='(?<!never )(?<!not )(?<!or )\b(apply|applies|add|adds|set|sets|put|puts)\b[^.]{0,30}IL/processed|(?<!never )(?<!not )(?<!or )\b(call|calls|invoke|invokes|use|uses|run|runs)\b[^.]{0,25}record_matches|(?<!never )(?<!not )(?<!or )\b(call|calls|use|uses)\b[^.]{0,25}\b(label_message|unlabel_message)\b|(?<!never )(?<!not )(?<!or )\b(apply|applies|add|adds|attach|attaches)\b[^.]{0,30}\blabels?\b[^.]{0,15} (to|on) [^.]{0,20}\b(messages?|mail|inbox|threads?)\b'

PATTERNS=("$REQUIRED_GATE" "$RECOMMENDED_CTX" "$IMMUTABLE_TYPE" "$NO_CHAINING" "$RENAME_REFS" \
          "$STORED_NAMESPACE" "$RUNTIME_MAIL" "$RUNTIME_ATTENTION" "$RUNTIME_WRITES")
NAMES=(required-gate recommended-context immutable-type no-chaining rename-refs \
       stored-namespace runtime-mail runtime-attention runtime-writes)

check 'the skill as written contradicts none of them' "$(fires_on_skill)" "none"

check 'attention is stored here and carried out elsewhere' \
    "$(says "Carrying it out is not this skill's job")$(says 'Nothing here stars a message, changes a read state, or looks at mail at all')" "yesyes"

echo
echo "--- the semantic guards are live: one contradictory sentence each ---"

check 'required_labels demoted to optional context is caught' \
    "$(with_sentence "$REQUIRED_GATE" 'required_labels may be treated as optional context.')" "detected"
check 'recommended_labels promoted to mandatory is caught' \
    "$(with_sentence "$RECOMMENDED_CTX" 'recommended_labels are mandatory and all must match.')" "detected"
check 'a mutable type is caught' \
    "$(with_sentence "$IMMUTABLE_TYPE" "An existing label's type may be changed from detection to derived.")" \
    "detected"
check 'derived-on-derived chaining is caught' \
    "$(with_sentence "$NO_CHAINING" 'A derived label may reference another derived label.')" "detected"
check 'a rename that leaves references behind is caught' \
    "$(with_sentence "$RENAME_REFS" 'Renaming a label does not update references from derived labels.')" \
    "detected"
check 'storing the IL/ prefix on a label is caught' \
    "$(with_sentence "$STORED_NAMESPACE" 'Store user label names with the IL/ prefix.')" "detected"

echo
echo "--- and so are the runtime guards ---"

check 'an instruction to read the inbox is caught' \
    "$(with_sentence "$RUNTIME_MAIL" 'Inspect the inbox and classify messages using the configured labels.')" \
    "detected"
check 'an instruction to classify mail is caught' \
    "$(with_sentence "$RUNTIME_MAIL" 'Classify ten messages from the inbox.')" "detected"
check 'an instruction to star mail is caught' \
    "$(with_sentence "$RUNTIME_ATTENTION" 'After managing labels, star high-attention messages.')" \
    "detected"
check 'an instruction to mark mail read is caught' \
    "$(with_sentence "$RUNTIME_ATTENTION" 'After 24 hours, mark none-attention messages read.')" "detected"
check 'an instruction to read the inbox and label mail is caught' \
    "$(with_sentence "$RUNTIME_MAIL" 'Read the inbox and label messages.')" "detected"
check 'an instruction to process inbox messages is caught' \
    "$(with_sentence "$RUNTIME_MAIL" 'Process ten inbox messages.')" "detected"
check 'an instruction to apply business labels to mail is caught' \
    "$(with_sentence "$RUNTIME_WRITES" 'Apply the configured business labels to inbox messages.')" \
    "detected"
check 'an instruction to unstar mail is caught' \
    "$(with_sentence "$RUNTIME_ATTENTION" 'Unstar high-attention mail.')" "detected"
check 'an instruction to archive mail is caught' \
    "$(with_sentence "$RUNTIME_ATTENTION" 'Archive messages after managing labels.')" "detected"
check 'a negated verb does not shelter a later positive instruction' \
    "$(with_sentence "$RUNTIME_ATTENTION" \
        'Manage never stars mail, but after setup archive messages.')" "detected"
check 'an instruction to record matches is caught' \
    "$(with_sentence "$RUNTIME_WRITES" 'Call record_matches after updating the label.')" "detected"
check 'an instruction to apply IL/processed is caught' \
    "$(with_sentence "$RUNTIME_WRITES" 'Apply IL/processed to the message after classification.')" "detected"

echo
echo "--- naming the runtime is not doing it: conceptual wording is accepted ---"

check 'stating what manage never writes is accepted' \
    "$(none_fire 'Manage never applies IL/processed or changes UNREAD.')" "clean"
check 'explaining the IL/ namespace is accepted' \
    "$(none_fire 'IL/ is the Gmail namespace used later during processing.')" "clean"
check 'handing attention execution to the other skill is accepted' \
    "$(none_fire 'Attention execution belongs to inbox-labeler-attention.')" "clean"
check 'a must-never prohibition of starring is accepted' \
    "$(none_fire 'Manage must never star mail.')" "clean"
check 'a does-not prohibition of marking read is accepted' \
    "$(none_fire 'Manage does not mark mail read after 24 hours.')" "clean"
check 'a never-calls prohibition of record_matches is accepted' \
    "$(none_fire 'Manage never calls record_matches after updates.')" "clean"

echo
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
