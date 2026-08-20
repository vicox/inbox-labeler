#!/usr/bin/env python3
"""Inbox Labeler — how often each label matches.

Counts live in data/matches.json, next to the labels they belong to but in a
separate file: labels.json is the policy the user writes, this is what happened
to it. Nothing here changes a label, and labels.py never reads these counts.

What is stored, and nothing else:

    the label            the text, exactly as labels.json spells it
    a calendar date      derived from the email's own timestamp, in UTC
    a count per date     how many matches that label had that day
    last_matched_at      the newest email timestamp the label has matched

**No part of an email is stored.** Not the body, the subject, the sender, the
recipients, the message or thread id, the attachments, or anything else about
it. A day and a number cannot be traced back to a message, and that is the point:
the store answers "how often does this label fire" and can answer nothing else.

A match is an occurrence the caller reports. Because nothing identifies the
email, reporting the same one twice counts it twice — there is deliberately no
deduplication here, since the only way to have it would be to keep the ids this
file exists to avoid. If it matters, it belongs at the boundary that knows about
emails, not in the counter.

Every command prints JSON to stdout and exits non-zero with {"error": ...} when
something is wrong.

Usage:
    matches.py record --at TIMESTAMP LABEL [LABEL ...]
    matches.py list
    matches.py get LABEL
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import labels

# Resolved the same way as labels.py's store, and for the same reason: the skill
# directory is reached through symlinks from .claude/skills/ and .agents/skills/,
# so resolve() follows those back to the real file here in skills/inbox-labeler/,
# and data/ is two levels up from it.
STORE = Path(__file__).resolve().parents[2] / "data" / "matches.json"

# labels.py owns the vocabulary; re-exported so callers of this module can catch
# what it raises without importing that one.
ValidationError = labels.ValidationError

DAY_FORMAT = "%Y-%m-%d"
TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


# --- timestamps ------------------------------------------------------------


def parse_timestamp(value):
    """Parse an ISO 8601 timestamp that carries a UTC offset, and return it in UTC.

    The offset is required. `2026-08-20T10:12:00` on its own is twenty-six
    different moments depending on who wrote it, and a day count that mixes them
    means nothing. Give it as `...Z` or as `...+02:00`.

    Sub-second precision is dropped: these timestamps are compared and stored at
    second resolution, which is finer than a store aggregated by day needs.
    """
    text = str(value).strip()
    # datetime.fromisoformat does not accept the Z suffix before Python 3.11.
    candidate = text[:-1] + "+00:00" if text[-1:] in ("Z", "z") else text
    try:
        moment = datetime.fromisoformat(candidate)
    except ValueError:
        raise ValidationError(
            "%r is not an ISO 8601 timestamp — expected something like "
            "2026-08-20T10:12:00Z or 2026-08-20T12:12:00+02:00" % text
        )
    if moment.tzinfo is None:
        raise ValidationError(
            "%r has no UTC offset, so the day it counts towards would be a guess — "
            "write it as 2026-08-20T10:12:00Z or 2026-08-20T12:12:00+02:00" % text
        )
    return moment.astimezone(timezone.utc).replace(microsecond=0)


def format_timestamp(moment):
    """The canonical stored form, always UTC: 2026-08-20T10:12:00Z."""
    return moment.astimezone(timezone.utc).strftime(TIMESTAMP_FORMAT)


def day_of(moment):
    """The calendar day a match counts towards, in UTC."""
    return moment.astimezone(timezone.utc).strftime(DAY_FORMAT)


# --- storage ---------------------------------------------------------------


def ordered(matches):
    """Labels alphabetically, days oldest first, so the file reads and diffs well."""
    result = {}
    for label in sorted(matches, key=lambda text: text.lower()):
        entry = matches[label]
        result[label] = {
            "last_matched_at": entry.get("last_matched_at"),
            "daily_matches": {
                day: entry["daily_matches"][day]
                for day in sorted(entry.get("daily_matches") or {})
            },
        }
    return result


def load_matches():
    """Read the counts, creating an empty store if there is none yet."""
    if not STORE.exists():
        save_matches({})
        return {}
    try:
        data = json.loads(STORE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValidationError("%s is not valid JSON: %s" % (STORE.name, exc))
    if not isinstance(data, dict):
        raise ValidationError("%s must contain a JSON object keyed by label" % STORE.name)
    return data


def save_matches(matches):
    STORE.parent.mkdir(parents=True, exist_ok=True)
    STORE.write_text(
        json.dumps(ordered(matches), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def empty_entry():
    return {"last_matched_at": None, "daily_matches": {}}


def find_key(matches, label):
    """The stored key for a label, matched the way labels are: ignoring case."""
    for key in matches:
        if labels.same_label(key, label):
            return key
    return None


# --- recording -------------------------------------------------------------


def record_matches(label_texts, email_timestamp):
    """Record one match for each of `label_texts`, all from the same email.

    `email_timestamp` is **the email's own timestamp**, not the moment this runs.
    Processing an old message during a backfill must raise that old day's count,
    which is what makes the history usable, so the caller passes the date the
    message carries and this file never looks at the clock.

    An email matching several labels is several matches. `Invoices`,
    `Large amount` and `Large invoice` on one message are three independent
    counts and are never collapsed into one — that they arrived together is not
    something this store knows or needs to know.
    """
    texts = list(label_texts)
    if not texts:
        raise ValidationError("no labels given: name at least one label that matched")

    moment = parse_timestamp(email_timestamp)
    day = day_of(moment)
    stamp = format_timestamp(moment)

    # Resolving against labels.json does two things: it rejects a label that does
    # not exist, and it gives the spelling labels.json uses, so the two files
    # agree on the key even when the caller wrote it in a different case.
    known = labels.load_labels()
    resolved = []
    for text in texts:
        label = labels.find(known, text)["label"]
        if label in resolved:
            raise ValidationError(
                'label "%s" was given twice for the same email — one email is one '
                "match per label" % label
            )
        resolved.append(label)

    matches = load_matches()
    recorded = {}
    for label in resolved:
        key = find_key(matches, label) or label
        entry = matches.setdefault(key, empty_entry())
        counts = entry.setdefault("daily_matches", {})
        counts[day] = int(counts.get(day, 0)) + 1
        # A backfilled email raises its own day's count but must never drag
        # last_matched_at backwards: that field is the newest email seen, not the
        # most recent thing done.
        previous = entry.get("last_matched_at")
        if previous is None or moment > parse_timestamp(previous):
            entry["last_matched_at"] = stamp
        recorded[label] = entry

    save_matches(matches)
    return ordered(recorded)


def record_match(label, email_timestamp):
    """Record a single match, and return that label's counts.

    See record_matches for what a match means here.
    """
    recorded = record_matches([label], email_timestamp)
    return next(iter(recorded.values()))


def get_matches(label=None):
    """Every label's counts, or one label's — empty if it has never matched."""
    matches = load_matches()
    if label is None:
        return ordered(matches)
    entry = labels.find(labels.load_labels(), label)
    key = find_key(matches, entry["label"])
    return ordered({entry["label"]: matches[key] if key else empty_entry()})


# --- following labels.py ---------------------------------------------------
#
# A label's text is its identifier, so renaming or deleting one in labels.json
# would strand or orphan its history here. labels.py calls both of these.


def rename_label(old, new):
    """Move a label's history to its new name. Returns None if it had none."""
    matches = load_matches()
    key = find_key(matches, old)
    if key is None:
        return None

    entry = matches.pop(key)
    target = find_key(matches, new)
    if target is None:
        matches[labels.normalise(new)] = entry
    else:
        # labels.py rejects a rename onto an existing label, so this is only
        # reachable if the two stores had already drifted. Merge rather than
        # overwrite: dropping counts silently is the failure worth avoiding.
        merged = matches[target]
        counts = merged.setdefault("daily_matches", {})
        for day, count in (entry.get("daily_matches") or {}).items():
            counts[day] = int(counts.get(day, 0)) + int(count)
        if newest(entry.get("last_matched_at"), merged.get("last_matched_at")):
            merged["last_matched_at"] = entry["last_matched_at"]
        entry = merged

    save_matches(matches)
    return entry


def newest(candidate, current):
    """Whether `candidate` is a later timestamp than `current`."""
    if candidate is None:
        return False
    if current is None:
        return True
    return parse_timestamp(candidate) > parse_timestamp(current)


def delete_label(label):
    """Drop a label's history. Returns None if it had none."""
    matches = load_matches()
    key = find_key(matches, label)
    if key is None:
        return None
    entry = matches.pop(key)
    save_matches(matches)
    return entry


# --- cli -------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Record and read Inbox Labeler match statistics."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    rec = sub.add_parser("record", help="record a match for one or more labels")
    rec.add_argument(
        "labels", nargs="+", metavar="LABEL",
        help="the labels that matched this email, by their exact label text",
    )
    rec.add_argument(
        "--at", required=True, metavar="TIMESTAMP",
        help=(
            "the email's own ISO 8601 timestamp with a UTC offset, e.g. "
            "2026-08-20T10:12:00Z — not the time you are running this"
        ),
    )

    sub.add_parser("list", help="the counts for every label that has matched")

    show = sub.add_parser("get", help="the counts for one label")
    show.add_argument("label", help="the label text")

    args = parser.parse_args(argv)

    try:
        if args.command == "record":
            moment = parse_timestamp(args.at)
            result = {
                "email_timestamp": format_timestamp(moment),
                "day": day_of(moment),
                "labels": record_matches(args.labels, args.at),
            }
        elif args.command == "get":
            result = get_matches(args.label)
        else:
            result = get_matches()
    except ValidationError as exc:
        print(json.dumps({"error": str(exc)}, indent=2))
        return 1

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
