#!/usr/bin/env python3
"""Inbox Labeler — local CRUD for labels.

A label is {label, type, instruction}, plus {required_labels,
recommended_labels} when it is derived. Labels live in data/labels.json at the
repository root. Every command prints JSON to stdout and exits non-zero with
{"error": ...} when something is wrong.

`label` is the label's only identifier. It is what the user reads, what other
labels reference, and how get, update and delete address it — there is no
separate name and no technical id. Labels are ordinary readable phrases and may
contain spaces: "Delivery arriving soon". They are matched case-insensitively
and stored with the spelling they were given.

`type` says how a label decides whether it applies. A `detection` label
inspects an email directly. A `derived` label interprets the email together
with the detection labels that matched it, naming them in `required_labels` and
`recommended_labels`. Another type is added by adding an entry to LABEL_TYPES
below — the operations in this file do not change.

`IL/` is Inbox Labeler's Gmail namespace — infrastructure, not part of a
label's identity — so it is added only when talking to Gmail, where
"Delivery arriving soon" resolves to "IL/Delivery arriving soon", spaces and
all. See gmail_label().

Usage:
    labels.py list
    labels.py get LABEL
    labels.py create --label LABEL --instruction TEXT [--type TYPE]
                     [--required-label LABEL ...] [--recommended-label LABEL ...]
    labels.py update LABEL [--label NEW] [--instruction TEXT] [--type TYPE]
                     [--required-label LABEL ...] [--recommended-label LABEL ...]
    labels.py delete LABEL
    labels.py attention [LABEL ...]
    labels.py policy ATTENTION --age AGE
    labels.py color ATTENTION

Passing --label to update renames the label and rewrites every reference to it.
"""

import argparse
import json
import sys
from pathlib import Path

# The store lives in the repository's data/ directory, not beside this script:
# the skill directory is reached through symlinks from .claude/skills/ and
# .agents/skills/, so resolve() first follows those back to the real file here
# in skills/inbox-labeler/, and data/ is two levels up from it.
STORE = Path(__file__).resolve().parents[2] / "data" / "labels.json"

# The Gmail namespace Inbox Labeler owns. Labels are stored without it and
# resolved through it on the way to Gmail.
GMAIL_NAMESPACE = "IL/"

# Inbox Labeler's own labels. They are internal state rather than anything a
# user models, so they are spelled lowercase — a convention that keeps them
# apart from the readable phrases users write — and reserved: no label may
# resolve to one of them. Matching is case-insensitive, so "Processed" is
# reserved too.
RESERVED_LABELS = {
    "processed": "Inbox Labeler's processing state",
    "no-match": "Inbox Labeler's evaluation outcome",
}

# What a label asks of the user. Attention is not a label and is not stored per
# message: the `attention` command computes it from the labels a message has and
# turns it into Gmail actions.
#
# The order is the priority aggregation follows, lowest first. `normal` is the
# absence of a request, so any label that does ask for something outranks it,
# and `high` outranks `none`.
ATTENTION_LEVELS = ("normal", "none", "high")
DEFAULT_ATTENTION = "normal"

# What the `attention` command does at each level. Fixed, not configurable.
ATTENTION_POLICIES = {
    "none": {"mark_read_after": "24h"},
    "normal": {},
    "high": {"star": True},
}

# Gmail label colors by attention level.
# Attention is the source of truth.
ATTENTION_COLORS = {
    "none": {"backgroundColor": "#cccccc", "textColor": "#000000"},
    "normal": {"backgroundColor": "#fce8b3", "textColor": "#000000"},
    "high": {"backgroundColor": "#efa093", "textColor": "#000000"},
}

DURATION_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}

# Fields every label carries, whatever its type.
COMMON_FIELDS = ("label", "type", "attention")

# The label types Inbox Labeler understands. `fields` are the type's own
# required text fields, on top of COMMON_FIELDS; `references` are its lists of
# labels pointing at other labels. Adding a type means adding an entry here —
# the CRUD operations stay as they are.
LABEL_TYPES = {
    "detection": {
        "summary": "inspects an email directly and decides whether its Gmail label applies",
        "fields": ("instruction",),
        "references": (),
    },
    "derived": {
        "summary": "interprets an email together with the detection labels that matched it",
        "fields": ("instruction",),
        "references": ("required_labels", "recommended_labels"),
    },
}
DEFAULT_TYPE = "detection"

# Every reference field any type declares, for validating the ones that do not.
REFERENCE_FIELDS = tuple(
    field for spec in LABEL_TYPES.values() for field in spec.get("references", ())
)


class ValidationError(Exception):
    pass


# --- labels ----------------------------------------------------------------


def gmail_label(label):
    """Resolve a label to the Gmail label Inbox Labeler applies, spaces and all."""
    return GMAIL_NAMESPACE + label


def strip_namespace(label):
    """Remove exactly one leading `IL/` from a label, if it has one."""
    if label[: len(GMAIL_NAMESPACE)].lower() == GMAIL_NAMESPACE.lower():
        return label[len(GMAIL_NAMESPACE):]
    return label


def normalise(label):
    """Trim the ends and collapse inner runs of whitespace to single spaces."""
    return " ".join(str(label).split())


def same_label(one, other):
    """Labels identify case-insensitively, so "large amount" is "Large amount"."""
    return normalise(one).lower() == normalise(other).lower()


# --- attention -------------------------------------------------------------


def parse_duration(value):
    """Turn "24h" or "2d" into seconds."""
    text = str(value).strip().lower()
    unit = text[-1:]
    if unit not in DURATION_UNITS or not text[:-1].isdigit():
        raise ValidationError(
            "duration %r must be a whole number followed by %s, e.g. 24h"
            % (value, "/".join(sorted(DURATION_UNITS)))
        )
    return int(text[:-1]) * DURATION_UNITS[unit]


def effective_attention(triggered):
    """The highest-priority attention among the labels a message carries.

    One `high` makes it `high`; failing that, one `none` makes it `none`;
    otherwise it stays `normal`. Nothing else is consulted: not the email, not
    the clock. A message with no labels comes out at the default, so it is left
    alone.
    """
    levels = []
    for entry in triggered or []:
        level = (entry.get("attention") or DEFAULT_ATTENTION).strip().lower()
        if level not in ATTENTION_LEVELS:
            raise ValidationError(
                "label %r has an unknown attention %r" % (entry.get("label"), level)
            )
        levels.append(level)
    if not levels:
        return DEFAULT_ATTENTION
    return max(levels, key=ATTENTION_LEVELS.index)


def attention_actions(attention, age_seconds):
    """What the `attention` command should do to a message, from its level alone.

    `age_seconds` is how long ago the message was received. Returns action names:

        star        add Gmail's star
        mark_read   clear UNREAD

    Labels are deliberately not an input, and no action ever touches an `IL/`
    label.
    """
    if attention not in ATTENTION_LEVELS:
        raise ValidationError(
            "unknown attention %r — levels: %s" % (attention, ", ".join(ATTENTION_LEVELS))
        )
    policy = ATTENTION_POLICIES[attention]
    age = max(0, int(age_seconds))

    if policy.get("star"):
        return ["star"]
    mark_read_after = policy.get("mark_read_after")
    if mark_read_after and age >= parse_duration(mark_read_after):
        return ["mark_read"]
    return []


def attention_color(attention):
    """The Gmail color for an attention level — the one place this is decided.

    Raises for a level outside ATTENTION_LEVELS and, separately, for a level
    that has no entry in ATTENTION_COLORS, so a gap in the mapping fails loudly
    instead of a label silently going uncolored.
    """
    if attention not in ATTENTION_LEVELS:
        raise ValidationError(
            "unknown attention %r — levels: %s" % (attention, ", ".join(ATTENTION_LEVELS))
        )
    color = ATTENTION_COLORS.get(attention)
    if not color:
        raise ValidationError("no Gmail color is configured for attention %r" % attention)
    return color


# --- storage ---------------------------------------------------------------


def ordered(entry):
    """Return the label's fields in canonical order: label, type, instruction, …"""
    spec = LABEL_TYPES.get(entry.get("type"), {})
    order = list(COMMON_FIELDS) + list(spec.get("fields", ())) + list(spec.get("references", ()))
    result = {field: entry[field] for field in order if field in entry}
    result.update({field: value for field, value in entry.items() if field not in result})
    return result


def load_labels():
    """Read all labels, creating an empty store if needed.

    Stores written by an earlier version are normalised here: a technical `id`
    and a separate `name` are dropped, a leftover `IL/` prefix is stripped,
    whitespace is collapsed, a missing `type` becomes detection, and a derived
    label's reference lists are filled in. Reads never write — the next save
    persists the normalised values.
    """
    if not STORE.exists():
        save_labels([])
        return []
    try:
        data = json.loads(STORE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValidationError("%s is not valid JSON: %s" % (STORE.name, exc))
    if not isinstance(data, list):
        raise ValidationError("%s must contain a JSON array" % STORE.name)
    for index, entry in enumerate(data):
        if not isinstance(entry, dict):
            continue
        entry.pop("id", None)
        if not entry.get("label") and entry.get("name"):
            entry["label"] = entry["name"]
        entry.pop("name", None)
        if isinstance(entry.get("label"), str):
            entry["label"] = normalise(strip_namespace(entry["label"].strip()))
        if not entry.get("type"):
            entry["type"] = DEFAULT_TYPE
        if not entry.get("attention"):
            entry["attention"] = DEFAULT_ATTENTION
        for field in LABEL_TYPES.get(entry["type"], {}).get("references", ()):
            entry[field] = [
                normalise(ref) for ref in entry.get(field) or [] if normalise(ref)
            ]
        data[index] = ordered(entry)
    return data


def save_labels(labels):
    STORE.parent.mkdir(parents=True, exist_ok=True)
    STORE.write_text(
        json.dumps(labels, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def find(labels, label):
    """Resolve a label by its text, case-insensitively."""
    for entry in labels:
        if same_label(entry.get("label", ""), label):
            return entry
    raise ValidationError("no label %r (use list to see them)" % normalise(label))


# --- validation ------------------------------------------------------------


def resolve_references(values, existing, own, field):
    """Check that every referenced label exists, and is a detection label.

    Returns the references spelled the way the labels they point at are spelled.
    """
    resolved = []
    for value in values or []:
        wanted = normalise(value)
        if not wanted:
            continue
        target = None
        for other in existing:
            if other is not own and same_label(other.get("label", ""), wanted):
                target = other
                break
        if target is None:
            known = ", ".join(
                '"%s"' % o.get("label")
                for o in existing
                if o is not own and o.get("type") == DEFAULT_TYPE
            )
            raise ValidationError(
                "%s references %r, which is not an existing label — detection labels: %s"
                % (field, wanted, known or "none yet")
            )
        if target.get("type") != DEFAULT_TYPE:
            raise ValidationError(
                '%s may only reference detection labels, and "%s" is a %s label'
                % (field, target.get("label"), target.get("type"))
            )
        if not any(same_label(target["label"], ref) for ref in resolved):
            resolved.append(target["label"])
    return resolved


def validate(entry, existing, own=None):
    """Validate a complete label. Returns a cleaned copy in canonical order."""
    cleaned = {field: normalise(entry.get(field) or "") for field in COMMON_FIELDS}
    cleaned["type"] = cleaned["type"].lower()
    cleaned["attention"] = (cleaned["attention"] or DEFAULT_ATTENTION).lower()
    label_type = cleaned["type"]
    label = cleaned["label"]

    if cleaned["attention"] not in ATTENTION_LEVELS:
        raise ValidationError(
            "unknown attention %r — levels, lowest priority first: %s"
            % (cleaned["attention"], ", ".join(ATTENTION_LEVELS))
        )

    if not label_type:
        raise ValidationError(
            "type must not be empty — supported types: %s" % ", ".join(sorted(LABEL_TYPES))
        )
    if label_type not in LABEL_TYPES:
        raise ValidationError(
            "unknown label type %r — supported types: %s"
            % (label_type, ", ".join(sorted(LABEL_TYPES)))
        )
    if own and own.get("type") and own["type"] != label_type:
        raise ValidationError(
            'a label\'s type is immutable: "%s" is a %s label and cannot become %s — '
            "create a new label instead" % (own.get("label"), own["type"], label_type)
        )

    if not label:
        raise ValidationError("label must not be empty")
    if label[: len(GMAIL_NAMESPACE)].lower() == GMAIL_NAMESPACE.lower():
        without = strip_namespace(label)
        raise ValidationError(
            "label is stored without the %s prefix, which Inbox Labeler adds for Gmail%s"
            % (GMAIL_NAMESPACE, (" — use %r instead of %r" % (without, label)) if without else "")
        )
    if label.startswith("/") or label.endswith("/") or "//" in label:
        raise ValidationError(
            "label must not start or end with '/' or contain '//' (it becomes %r in Gmail)"
            % gmail_label(label)
        )
    for reserved, purpose in RESERVED_LABELS.items():
        if same_label(label, reserved):
            raise ValidationError(
                '"%s" is a reserved system label: %s is %s, not something a label may model '
                "— choose a different label" % (label, gmail_label(reserved), purpose)
            )
    for other in existing:
        if other is not own and same_label(other.get("label", ""), label):
            raise ValidationError(
                'a label called "%s" already exists — labels are unique, ignoring case'
                % other["label"]
            )

    for field in LABEL_TYPES[label_type]["fields"]:
        value = (entry.get(field) or "").strip()
        if not value:
            raise ValidationError("%s must not be empty for a %s label" % (field, label_type))
        cleaned[field] = value

    references = LABEL_TYPES[label_type].get("references", ())
    for field in REFERENCE_FIELDS:
        if field in references:
            cleaned[field] = resolve_references(entry.get(field), existing, own, field)
        elif entry.get(field):
            supported = ", ".join(
                sorted(t for t, s in LABEL_TYPES.items() if field in s.get("references", ()))
            )
            raise ValidationError(
                "%s applies to %s labels, not to a %s label" % (field, supported, label_type)
            )

    return ordered(cleaned)


# --- operations ------------------------------------------------------------


def list_labels():
    return load_labels()


def get_label(label):
    return find(load_labels(), label)


def create_label(
    label,
    instruction,
    label_type=DEFAULT_TYPE,
    attention=DEFAULT_ATTENTION,
    required_labels=None,
    recommended_labels=None,
):
    labels = load_labels()
    entry = validate(
        {
            "label": label,
            "type": label_type,
            "attention": attention,
            "instruction": instruction,
            "required_labels": required_labels,
            "recommended_labels": recommended_labels,
        },
        labels,
    )
    labels.append(entry)
    save_labels(labels)
    return entry


def sync_match_store(change):
    """Apply a label change to the match store too, which is keyed by label text.

    `change` is called with the matches module. That module is imported here
    rather than at the top of the file because it imports this one; and its
    failures are re-raised as our own error because running this file as a script
    leaves matches.py holding a second copy of this module, whose ValidationError
    is a different class than the one main() catches.
    """
    import matches

    try:
        change(matches)
    except matches.ValidationError as exc:
        raise ValidationError(str(exc)) from None


def rename_references(labels, old, new):
    """Point every reference to `old` at `new` instead."""
    for other in labels:
        for field in LABEL_TYPES.get(other.get("type"), {}).get("references", ()):
            other[field] = [
                new if same_label(ref, old) else ref for ref in other.get(field, [])
            ]


def update_label(
    label,
    new_label=None,
    instruction=None,
    label_type=None,
    attention=None,
    required_labels=None,
    recommended_labels=None,
):
    changes = {
        "label": new_label,
        "instruction": instruction,
        "type": label_type,
        "attention": attention,
        "required_labels": required_labels,
        "recommended_labels": recommended_labels,
    }
    if all(value is None for value in changes.values()):
        raise ValidationError(
            "nothing to update: pass --label, --type, --attention, --instruction, "
            "--required-label or --recommended-label"
        )
    labels = load_labels()
    entry = find(labels, label)
    previous = entry["label"]
    merged = dict(entry)
    merged.update({field: value for field, value in changes.items() if value is not None})
    cleaned = validate(merged, labels, own=entry)
    entry.clear()
    entry.update(cleaned)
    if cleaned["label"] != previous:
        rename_references(labels, previous, cleaned["label"])
    save_labels(labels)
    if cleaned["label"] != previous:
        sync_match_store(lambda m: m.rename_label(previous, cleaned["label"]))
    return entry


def referencing_labels(labels, entry):
    """Labels whose reference lists point at this label."""
    found = []
    for other in labels:
        if other is entry:
            continue
        fields = LABEL_TYPES.get(other.get("type"), {}).get("references", ())
        if any(
            same_label(ref, entry.get("label", ""))
            for field in fields
            for ref in other.get(field, [])
        ):
            found.append(other)
    return found


def delete_label(label):
    for reserved, purpose in RESERVED_LABELS.items():
        if same_label(label, reserved):
            raise ValidationError(
                '"%s" is a reserved system label: %s is %s and is not stored as a label, '
                "so there is nothing to delete" % (normalise(label), gmail_label(reserved), purpose)
            )
    labels = load_labels()
    entry = find(labels, label)
    blocking = referencing_labels(labels, entry)
    if blocking:
        kinds = "/".join(sorted({o.get("type", "") for o in blocking}))
        raise ValidationError(
            'cannot delete %s label "%s": it is referenced by %s label%s %s — '
            "remove the reference first"
            % (
                entry.get("type"),
                entry.get("label"),
                kinds,
                "" if len(blocking) == 1 else "s",
                ", ".join('"%s"' % o.get("label") for o in blocking),
            )
        )
    labels.remove(entry)
    save_labels(labels)
    sync_match_store(lambda m: m.delete_label(entry["label"]))
    return entry


# --- cli -------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(description="Manage Inbox Labeler labels.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="list all labels")

    show = sub.add_parser("get", help="show one label")
    show.add_argument("label", help="the label text, e.g. \"Delivery arriving soon\"")

    type_help = "label type (default: %s — %s)" % (
        DEFAULT_TYPE,
        ", ".join(sorted(LABEL_TYPES)),
    )
    attention_help = "what this label asks of the user (default: %s — %s)" % (
        DEFAULT_ATTENTION,
        ", ".join(ATTENTION_LEVELS),
    )
    label_help = (
        'the label, a readable phrase that may contain spaces, e.g. "Delivery arriving soon" '
        "(becomes IL/Delivery arriving soon in Gmail); no IL/ prefix"
    )
    required_help = (
        "derived labels only: a detection label that must have matched before this label is "
        "evaluated, given as its exact label text (repeatable)"
    )
    recommended_help = (
        "derived labels only: a detection label to offer as context when it matched, given as "
        "its exact label text (repeatable)"
    )

    create = sub.add_parser("create", help="create a label")
    create.add_argument("--label", required=True, help=label_help)
    create.add_argument(
        "--instruction", required=True, help="how Claude decides whether the label applies"
    )
    create.add_argument("--type", default=DEFAULT_TYPE, help=type_help)
    create.add_argument("--attention", default=DEFAULT_ATTENTION, help=attention_help)
    create.add_argument(
        "--required-label", action="append", dest="required_labels", metavar="LABEL",
        help=required_help,
    )
    create.add_argument(
        "--recommended-label", action="append", dest="recommended_labels", metavar="LABEL",
        help=recommended_help,
    )

    update = sub.add_parser("update", help="update a label")
    update.add_argument("label", help="the label to update, by its current text")
    update.add_argument(
        "--label", dest="new_label",
        help="rename the label to this text; every reference to it is updated too",
    )
    update.add_argument("--instruction")
    update.add_argument("--type", help=type_help)
    update.add_argument("--attention", help=attention_help)
    update.add_argument(
        "--required-label", action="append", dest="required_labels", metavar="LABEL",
        help=required_help + "; replaces the stored list",
    )
    update.add_argument(
        "--recommended-label", action="append", dest="recommended_labels", metavar="LABEL",
        help=recommended_help + "; replaces the stored list",
    )

    delete = sub.add_parser("delete", help="delete a label")
    delete.add_argument("label", help="the label text")

    level = sub.add_parser(
        "attention", help="the effective attention for the labels a message carries"
    )
    level.add_argument("labels", nargs="*", metavar="LABEL", help="the labels on the message")

    act = sub.add_parser(
        "policy", help="what the attention command should do to a message at this level"
    )
    act.add_argument("attention", choices=ATTENTION_LEVELS)
    act.add_argument("--age", required=True, help="how long ago it was received, e.g. 30h")

    col = sub.add_parser(
        "color", help="the Gmail color for an attention level"
    )
    col.add_argument("attention", choices=ATTENTION_LEVELS)

    args = parser.parse_args(argv)

    try:
        if args.command == "list":
            result = list_labels()
        elif args.command == "get":
            result = get_label(args.label)
        elif args.command == "create":
            result = create_label(
                args.label,
                args.instruction,
                args.type,
                args.attention,
                args.required_labels,
                args.recommended_labels,
            )
        elif args.command == "update":
            result = update_label(
                args.label,
                args.new_label,
                args.instruction,
                args.type,
                args.attention,
                args.required_labels,
                args.recommended_labels,
            )
        elif args.command == "attention":
            labels = load_labels()
            triggered, unknown = [], []
            for text in args.labels or []:
                match = next((e for e in labels if same_label(e["label"], text)), None)
                (triggered if match else unknown).append(match or normalise(text))
            result = {
                "attention": effective_attention(triggered),
                "from": {e["label"]: e["attention"] for e in triggered},
                "unknown": unknown,
            }
        elif args.command == "policy":
            result = {
                "attention": args.attention,
                "actions": attention_actions(args.attention, parse_duration(args.age)),
            }
        elif args.command == "color":
            result = {"attention": args.attention, "color": attention_color(args.attention)}
        else:
            result = delete_label(args.label)
    except ValidationError as exc:
        print(json.dumps({"error": str(exc)}, indent=2))
        return 1

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
