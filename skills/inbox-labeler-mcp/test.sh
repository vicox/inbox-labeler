#!/usr/bin/env bash
# Hosted Inbox Labeler skill tests.
#
#   ./test.sh
#
# The hosted skill is a document, not a program: there is nothing to execute and
# no local state to inspect. What can still be protected is the set of invariants
# an agent reads it for — and those are exactly the ones that were weakened once
# already when the local skill was ported, so they are worth pinning.
#
# The checks assert *semantics*, not formatting. Each asks a question about what
# the document says — "is unread required for normal processing?" — and answers it
# from the section that is authoritative for it. Both sides of every comparison
# are normalised: whitespace collapses, and markdown decoration (backticks,
# emphasis) is stripped. So rewrapping a paragraph, or emphasising a phrase that
# was not emphasised before, does not fail a test, while a changed rule does.
#
# Prints one line per check and exits non-zero if any of them fails.

set -u

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/../.." && pwd -P)"
export SKILL="$SCRIPT_DIR/SKILL.md"

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

# The helper is written to a private temporary directory, never into the source
# tree: a test that drops a file next to the thing it is testing can overwrite
# something real, and two runs at once would share it. `mktemp -d` gives each
# invocation its own, and the trap removes that one and nothing else.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
HELPER="$WORK/helper.py"

# section <heading> — one section's body, normalised, up to the next heading of
# the same or a higher level. Subsections are included, which is what makes a
# step and its sub-parts one unit to ask questions of.
section() {
    python3 "$HELPER" section "$1"
}

# says <section-body> <phrase>... — how many of the phrases the body contains.
# Compare against the count you expect, so a check that means "all three of
# these" says so rather than collapsing to a boolean.
says() {
    python3 "$HELPER" says "$@"
}

# denies <body> <phrase>... — the same, ignoring case. Only the deny-lists use
# it: a reversal would most likely arrive as the first words of a new sentence,
# capitalised, and a case-sensitive deny-list would miss exactly that. The
# positive checks stay case-sensitive, because there the exact wording is the
# thing being pinned.
denies() {
    python3 "$HELPER" denies "$@"
}

# The helper lives in a file rather than a heredoc so that phrases containing
# backticks, apostrophes and asterisks need no shell escaping at all — that
# escaping is the one thing in a test like this that silently turns an assertion
# into a tautology.
cat > "$HELPER" <<'HELPER'
import os, re, sys


def normalise(text):
    """Collapse whitespace and drop markdown decoration, on both sides."""
    return re.sub(r"\s+", " ", re.sub(r"[`*_]", "", text)).strip()


def body(wanted):
    text = open(os.environ["SKILL"], encoding="utf-8").read()
    if wanted == "ALL":
        return normalise(text)
    level = len(wanted) - len(wanted.lstrip("#"))
    keeping, out = False, []
    for line in text.splitlines():
        if line.strip() == wanted:
            keeping = True
            continue
        if keeping and re.match(r"^#{1,%d} " % level, line):
            break
        if keeping:
            out.append(line)
    if not out:
        raise SystemExit("NO SUCH SECTION: %s" % wanted)
    return normalise("\n".join(out))


command = sys.argv[1]
if command == "section":
    print(body(sys.argv[2]))
elif command == "says":
    haystack = normalise(sys.argv[2])
    print(sum(normalise(p) in haystack for p in sys.argv[3:]))
elif command == "denies":
    haystack = normalise(sys.argv[2]).lower()
    print(sum(normalise(p).lower() in haystack for p in sys.argv[3:]))
elif command == "anchors":
    # Every in-document link target, against every heading slug. Lives here
    # rather than inline because the slug rule strips backticks, and a backtick
    # inside a shell command substitution starts a command substitution.
    text = open(os.environ["SKILL"], encoding="utf-8").read()
    headings = set()
    for line in text.splitlines():
        m = re.match(r"^#+\s+(.*)$", line)
        if not m:
            continue
        slug = re.sub(r"[^a-z0-9 -]", "", re.sub(r"[`*]", "", m.group(1).lower()))
        headings.add(slug.strip().replace(" ", "-"))
    missing = sorted({a for a in re.findall(r"\]\(#([a-z0-9-]+)\)", text)} - headings)
    print(",".join(missing) if missing else "none")
HELPER

ALL="$(section ALL)"
SELECT="$(section '### 3. Select the messages to process')"
BOUND="$(section '### Bound each run')"
ATTENTION="$(section '## Apply attention')"
SCOPE="$(section '### Scope and the two markers')"
SAFETY="$(section '## Safety and consistency rules')"
ONEATATIME="$(section '### One message at a time')"
COMMIT="$(section '### 8. Commit the mailbox state, then record what matched')"
CAPABILITY="$(section '### What the mail connection has to be able to do')"

# --- 1-3. all three eligibility conditions, in the authoritative place ------
#
# The rule is one sentence and it has to keep all three conjuncts. Each is
# checked on its own, so dropping any single one fails a named check.

check "the eligibility rule requires the inbox" \
    "$(says "$SELECT" 'currently in the inbox')" "1"
check "the eligibility rule requires unread" \
    "$(says "$SELECT" 'are currently unread')" "1"
check "the eligibility rule requires the absence of IL/processed" \
    "$(says "$SELECT" 'do not carry IL/processed')" "1"
check "all three are required together" \
    "$(says "$SELECT" 'All three conditions are required')" "1"
check "failing any one of them skips the message" \
    "$(says "$SELECT" 'failing any one of them is skipped')" "1"
check "the rule declares itself the single authority" \
    "$(says "$SELECT" 'This is the authoritative eligibility rule')" "1"
check "selection comes before detection in the workflow" \
    "$(python3 -c "
import sys
s = sys.argv[1]
print(s.index('3. Select the messages to process') < s.index('4. Evaluate detection labels'))
" "$(grep -o '^### [0-9]\..*' "$SKILL" | tr '\n' '|')")" "True"

# --- 4. eligibility is enforced per individual message ---------------------
#
# The check the local skill had and the first port of the hosted one did not.

check "there is a per-message re-check" \
    "$(says "$SELECT" 'Re-check every message individually')" "1"
check "it happens immediately before processing each message" \
    "$(says "$SELECT" 'Immediately before processing each individual message, re-check all three conditions')" "1"
check "it asks all three questions" \
    "$(says "$SELECT" 'Is it in the inbox?' 'Is it currently unread?' 'Does it lack IL/processed?')" "3"
check "thread-shaped results are given as the reason" \
    "$(says "$SELECT" 'thread-shaped results')" "1"
check "the message itself, not the search, is the authority" \
    "$(says "$SELECT" 'A search result is a suggestion; the message itself is the authority')" "1"
check "a failed re-check applies nothing and records nothing" \
    "$(says "$SELECT" \
        'do not classify it' \
        'do not apply a semantic IL/ label' \
        'do not apply IL/no-match' \
        'do not apply IL/processed' \
        'do not call record_matches')" "5"
check "one message at a time points at the same re-check" \
    "$(says "$ONEATATIME" 're-check each message')" "1"

# --- 5. read mail is out of scope, deliberately ---------------------------

check "a read message without the marker is out of scope" \
    "$(says "$SELECT" 'A read message with no IL/processed is out of scope')" "1"
check "and normal processing never goes back for it" \
    "$(says "$SELECT" 'Normal processing never reaches back for it')" "1"
check "an unread message with the marker is out of scope for processing" \
    "$(says "$SELECT" 'An unread message carrying IL/processed is out of scope for normal processing')" "1"

# --- 2/6. scope filter and processing state stay distinct -----------------

check "unread is a scope filter and the marker is a processing state" \
    "$(says "$SELECT" 'Unread is a scope filter; IL/processed is a processing state')" "1"
check "neither substitutes for the other" \
    "$(says "$SELECT" 'neither substitutes for the other')" "1"
check "processing never changes the read state, in the selection step" \
    "$(says "$SELECT" 'Processing never changes a message')" "1"
check "and again in the safety rules" \
    "$(says "$SAFETY" 'Never change the unread state during processing')" "1"
check "the safety rules name all three conditions" \
    "$(says "$SAFETY" 'inbox and unread and not IL/processed')" "1"
check "the safety rules point at the authoritative step rather than restating it" \
    "$(says "$SAFETY" 'Step 3')" "1"

# --- 7-8. attention is the mirror image, and owns marking read ------------

check "attention is scoped to unread inbox mail carrying the marker" \
    "$(says "$ATTENTION" 'in the inbox, unread, and do carry IL/processed')" "1"
check "the mirror-image relationship is spelled out" \
    "$(says "$ATTENTION" 'mirror image of normal processing')" "1"
check "read mail is out of scope for attention too" \
    "$(says "$ATTENTION" 'Read mail is out of scope for both')" "1"
check "attention re-checks per message as well" \
    "$(says "$ATTENTION" 'Re-check those three on each message before acting on it')" "1"
check "the three attention actions are unchanged" \
    "$(says "$ATTENTION" \
        'high | star the message' \
        'none | mark it read once it is at least 24 hours old' \
        'normal | no action')" "3"
check "marking read belongs to attention and nowhere else" \
    "$(says "$ATTENTION" 'Marking read belongs here and nowhere else')" "1"
check "attention writes only those two things" \
    "$(says "$ATTENTION" 'Starring and marking read are the only two things this workflow writes')" "1"
check "attention still adds and removes no IL/ label" \
    "$(says "$ATTENTION" 'It never touches an IL/ label in either direction')" "1"

# --- 9. IL/no-match is not an eligibility predicate -----------------------

check "only IL/processed takes part in eligibility" \
    "$(says "$SCOPE" 'Only IL/processed takes part in eligibility')" "1"
check "IL/no-match decides nothing about eligibility" \
    "$(says "$SCOPE" 'decides nothing about whether a message may be processed')" "1"
check "IL/processed is never inferred from IL/no-match" \
    "$(says "$SCOPE" 'Never infer IL/processed from IL/no-match')" "1"
check "a completed no-match commit leaves both markers" \
    "$(says "$SCOPE" 'a no-match message carries both')" "1"
check "a partial write may leave IL/no-match without IL/processed" \
    "$(says "$SCOPE" 'can carry IL/no-match with IL/processed absent')" "1"
check "and that message is still eligible on a later run" \
    "$(says "$SCOPE" 'still eligible' 'still without IL/processed')" "2"
check "eligibility turns on IL/processed and on nothing else" \
    "$(says "$SCOPE" 'the re-check asks about IL/processed, and about nothing else')" "1"
check "the partial case points at State B rather than inventing a rule" \
    "$(says "$SCOPE" '[State B](#b-the-mailbox-commit-did-not-clearly-succeed)')" "1"
check "IL/no-match still means the detection stage only" \
    "$(says "$SCOPE" 'IL/no-match is about the detection stage only')" "1"
check "a no-match message may still carry an ungated derived label" \
    "$(says "$ALL" 'can legitimately carry IL/no-match and a derived label')" "1"

# --- 10-11. ten is a hard maximum with no override -----------------------

check "ten is stated as a hard maximum" \
    "$(says "$BOUND" 'Ten is a hard maximum, not a default')" "1"
check "nothing raises it" \
    "$(says "$BOUND" 'Nothing raises it')" "1"
check "the ways a user might ask are answered explicitly" \
    "$(says "$BOUND" 'Process fifty' 'process my entire inbox' 'process all my unread mail' 'ignore the limit')" "4"
check "no request produces an eleventh message" \
    "$(says "$BOUND" 'no user request that produces an eleventh message')" "1"
check "no override is offered as a workaround" \
    "$(says "$BOUND" 'no override to offer as a workaround')" "1"
check "a truncated run reports that more remain" \
    "$(says "$BOUND" 'whether more eligible messages remain')" "1"
check "the limit never changes which messages are eligible" \
    "$(says "$BOUND" 'never which ones')" "1"
check "the safety rules also call ten a hard maximum" \
    "$(says "$SAFETY" 'hard maximum')" "1"
check "no wording anywhere makes the bound a default or configurable" \
    "$(denies "$ALL" \
        'By default, handle at most' \
        'different bounded number' \
        'raise the bound' \
        'if the user explicitly asks for a different')" "0"

# --- negative checks: the four ways this could be reversed ---------------
#
# Positive substring checks cannot catch every way prose could contradict itself,
# and these do not try to. They are a deny-list of the specific phrasings a
# reversal of each rule would most plausibly introduce — cheap, literal, and
# maintainable. Subtler contradictions remain the reviewer's job, which is stated
# here so nobody mistakes a green run for a proof.

check "nothing says read mail may be normally processed" \
    "$(denies "$ALL" \
        'read mail is eligible' \
        'read messages are eligible' \
        'read mail may be processed' \
        'including read mail' \
        'regardless of read state' \
        'even if it has been read' \
        'unread is not required')" "0"

check "nothing offers a way past the ten-message maximum" \
    "$(denies "$ALL" \
        'more than ten messages' \
        'raise the limit' \
        'increase the limit' \
        'without a limit' \
        'unbounded' \
        'as many as the user asks')" "0"

check "nothing lets processing mark mail read" \
    "$(denies "$ALL" \
        'processing may mark' \
        'marks it read during processing' \
        'processing marks the message read' \
        'mark it read during processing')" "0"

check "nothing treats IL/no-match as an eligibility or completion marker" \
    "$(denies "$ALL" \
        'IL/no-match is the completion marker' \
        'IL/no-match marks the message as processed' \
        'IL/no-match takes part in eligibility' \
        'carrying IL/no-match is out of scope' \
        'skip a message carrying IL/no-match')" "0"

# --- 12. search-layer guidance, including unread -------------------------

check "there is search-layer guidance" \
    "$(says "$SELECT" 'Narrow the search where the mail system can')" "1"
check "the search is asked to filter on all three conditions" \
    "$(says "$SELECT" 'candidates that are already in the inbox, unread and without IL/processed')" "1"
check "narrowing is an optimisation, not the guarantee" \
    "$(says "$SELECT" 'Narrowing the search is an optimisation, never the guarantee')" "1"
check "a mail system that cannot express the conditions is still handled" \
    "$(says "$SELECT" 'cannot express one of the three conditions at all')" "1"

# --- 13. Gmail is an example, never the normative interface --------------

check "the Gmail query is present as guidance" \
    "$(says "$SELECT" 'in:inbox is:unread -label:')" "1"
check "it is introduced as one example" \
    "$(says "$SELECT" 'Gmail, as one example')" "1"
check "it is disclaimed as not the interface" \
    "$(says "$SELECT" 'This is an illustration, not the interface')" "1"
check "the label id caveat is stated rather than assumed" \
    "$(says "$SELECT" "want that label's id rather than its display name")" "1"
check "the eligibility rule itself names no platform and no syntax" \
    "$(python3 -c "
import sys
rule = sys.argv[1]
rule = rule[rule.index('During normal processing, consider only'):][:400]
print(sum(p in rule for p in ['Gmail', 'in:inbox', 'is:unread', 'label:']))
" "$SELECT")" "0"
check "every Gmail mention in the selection step sits beside an example or a caveat" \
    "$(python3 -c "
import re, sys
loose = [s for s in re.findall(r'[^.]*Gmail[^.]*\.', sys.argv[1])
         if not re.search(r'example|illustration|connector|Another mail system', s)]
print(len(loose))
" "$SELECT")" "0"
check "the capability list requires abilities, not a named platform's tools" \
    "$(python3 -c "
import sys
print(sum(p in sys.argv[1] for p in ['search_threads', 'label_message', 'unlabel_message', 'get_thread', 'list_labels']))
" "$CAPABILITY")" "0"
check "the capability list requires reading inbox membership and read state" \
    "$(says "$CAPABILITY" 'tell whether a message is in the inbox and whether it is currently unread')" "1"

# --- semantics this pass must not have regressed -------------------------
#
# Not a re-test of the whole document — the invariants a careless edit to the
# sections above could plausibly have broken.

check "a message is still the unit of work" \
    "$(says "$ONEATATIME" 'The unit of work is a message, never a thread')" "1"
check "detection still precedes derived" \
    "$(says "$SAFETY" 'Detection before derived, always')" "1"
check "required_labels is still an AND gate and recommended_labels still context" \
    "$(says "$ALL" 'is an AND gate' 'is context, not a gate')" "2"
check "there is still no chaining between derived labels" \
    "$(says "$ALL" 'There is no chaining from one derived label to another')" "1"
check "the commit sequence is still authoritative" \
    "$(says "$COMMIT" 'This is the authoritative per-message sequence')" "1"
check "and still refers to the renumbered steps 4, 5 and 6" \
    "$(says "$COMMIT" '(step 4)' '(step 5)' '(step 6)')" "3"
check "IL/processed still goes on last within the mailbox phase" \
    "$(says "$ALL" 'IL/processed goes on after the labels it vouches for')" "1"
check "history is still never written before the mailbox commit" \
    "$(says "$ALL" 'made only after the commit succeeded')" "1"
check "State C is still the failure that does not heal" \
    "$(says "$ALL" 'it is the one failure that does not heal')" "1"
check "a history failure still leaves IL/processed in place" \
    "$(says "$ALL" 'The message stays processed')" "1"
check "record_matches still uses the email's own timestamp" \
    "$(says "$ALL" "The timestamp is the email's own, never the moment you are running")" "1"
check "history still never influences classification" \
    "$(says "$ALL" 'It must never influence classification')" "1"
check "attention still ranks high over none over normal" \
    "$(says "$ALL" 'high > none > normal')" "1"
check "the colour mapping is still the whole mapping" \
    "$(says "$ALL" 'These three rows are the whole mapping')" "1"
check "an unreachable MCP still stops the run" \
    "$(says "$ALL" 'The Inbox Labeler MCP is unreachable → stop and say so')" "1"
check "a missing marker capability still means a plan and no processing" \
    "$(says "$ALL" 'this run does not process anything')" "1"
check "star and read capability still affects attention only" \
    "$(says "$ALL" 'Starring or marking read is unavailable → processing is unaffected')" "1"

# --- every internal link still resolves ----------------------------------
#
# The core workflow was renumbered when the selection step was added, so a stale
# anchor is the most likely way that could have gone wrong.

check "every in-document anchor link resolves to a heading" \
    "$(python3 "$HELPER" anchors)" "none"

# --- the old local skill is a separate artifact --------------------------

check "the hosted skill borrows nothing from the local skill's implementation" \
    "$(python3 -c "
import sys
print(sum(p in sys.argv[1] for p in ['labels.py', 'matches.py', 'gdrive-store', 'data/labels.json']))
" "$ALL")" "0"
check "the local skill still states its own rule, untouched by this one" \
    "$(grep -c 'Only unread inbox messages are ever touched' "$REPO_ROOT/skills/inbox-labeler/SKILL.md")" "1"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
