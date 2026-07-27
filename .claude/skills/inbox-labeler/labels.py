#!/usr/bin/env python3
"""Inbox Labeler — local CRUD for labels.

A label is {label, type, instruction}, plus {required_labels,
recommended_labels} when it is derived. Labels live in labels.json next to this
script. Every command prints JSON to stdout and exits non-zero with
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

Passing --label to update renames the label and rewrites every reference to it.
"""

import argparse
import json
import sys
from pathlib import Path

STORE = Path(__file__).resolve().parent / "labels.json"

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
    "nomatch": "Inbox Labeler's evaluation outcome",
}

# Fields every label carries, whatever its type.
COMMON_FIELDS = ("label", "type")

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
        for field in LABEL_TYPES.get(entry["type"], {}).get("references", ()):
            entry[field] = [
                normalise(ref) for ref in entry.get(field) or [] if normalise(ref)
            ]
        data[index] = ordered(entry)
    return data


def save_labels(labels):
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
    label_type = cleaned["type"]
    label = cleaned["label"]

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
    required_labels=None,
    recommended_labels=None,
):
    labels = load_labels()
    entry = validate(
        {
            "label": label,
            "type": label_type,
            "instruction": instruction,
            "required_labels": required_labels,
            "recommended_labels": recommended_labels,
        },
        labels,
    )
    labels.append(entry)
    save_labels(labels)
    return entry


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
    required_labels=None,
    recommended_labels=None,
):
    changes = {
        "label": new_label,
        "instruction": instruction,
        "type": label_type,
        "required_labels": required_labels,
        "recommended_labels": recommended_labels,
    }
    if all(value is None for value in changes.values()):
        raise ValidationError(
            "nothing to update: pass --label, --type, --instruction, "
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
                args.required_labels,
                args.recommended_labels,
            )
        elif args.command == "update":
            result = update_label(
                args.label,
                args.new_label,
                args.instruction,
                args.type,
                args.required_labels,
                args.recommended_labels,
            )
        else:
            result = delete_label(args.label)
    except ValidationError as exc:
        print(json.dumps({"error": str(exc)}, indent=2))
        return 1

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
