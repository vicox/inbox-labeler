#!/usr/bin/env python3
"""Inbox Labeler — local CRUD for labels.

A label is {id, name, label, type, instruction} and lives in labels.json next
to this script. Every command prints JSON to stdout and exits non-zero with
{"error": ...} when something is wrong.

`type` says how a label decides whether it applies. Today the only type is
`detection`: a detection label inspects an email directly. Another type is
added by adding an entry to LABEL_TYPES below — the operations in this file do
not change.

`label` holds the *logical* label and is stored without a prefix ("Invoices").
`IL/` is Inbox Labeler's Gmail namespace — infrastructure, not part of a
label's identity — so it is added only when talking to Gmail, where the logical
label resolves to `IL/Invoices`. See gmail_label().

Usage:
    labels.py list
    labels.py get ID
    labels.py create --name NAME --label LABEL --instruction TEXT [--type detection]
    labels.py update ID [--name NAME] [--label LABEL] [--instruction TEXT] [--type TYPE]
    labels.py delete ID

get, update and delete take the label id only — never the name. Use list to
look up the id belonging to a name.
"""

import argparse
import json
import sys
import uuid
from pathlib import Path

STORE = Path(__file__).resolve().parent / "labels.json"

# The Gmail namespace Inbox Labeler owns. Logical labels are stored without it
# and resolved through it on the way to Gmail.
GMAIL_NAMESPACE = "IL/"

# Inbox Labeler's own Gmail labels are IL/Processed and IL/NoMatch, so these
# logical labels are reserved: a label may not resolve to one of them.
RESERVED_LABELS = {
    "Processed": "Inbox Labeler's processing state",
    "NoMatch": "Inbox Labeler's evaluation outcome",
}

# Fields every label carries, whatever its type.
COMMON_FIELDS = ("name", "label", "type")

# The label types Inbox Labeler understands. `fields` are the type's own
# required text fields, on top of COMMON_FIELDS. Adding a type — `derived`,
# say — means adding an entry here, and a check in validate() only if it needs
# more than non-empty text fields. The CRUD operations stay as they are.
LABEL_TYPES = {
    "detection": {
        "summary": "inspects an email directly and decides whether its Gmail label applies",
        "fields": ("instruction",),
    },
}
DEFAULT_TYPE = "detection"


class ValidationError(Exception):
    pass


# --- logical labels --------------------------------------------------------


def gmail_label(label):
    """Resolve a logical label to the Gmail label Inbox Labeler applies."""
    return GMAIL_NAMESPACE + label


def strip_namespace(label):
    """Remove exactly one leading `IL/` from a label, if it has one."""
    if label[: len(GMAIL_NAMESPACE)].lower() == GMAIL_NAMESPACE.lower():
        return label[len(GMAIL_NAMESPACE):]
    return label


# --- storage ---------------------------------------------------------------


def ordered(entry):
    """Return the label's fields in canonical order: id, name, label, type, …"""
    order = ["id"] + list(COMMON_FIELDS)
    order += list(LABEL_TYPES.get(entry.get("type"), {}).get("fields", ()))
    result = {field: entry[field] for field in order if field in entry}
    result.update({field: value for field, value in entry.items() if field not in result})
    return result


def load_labels():
    """Read all labels, creating an empty store if needed.

    Two normalisations happen here, both for stores written by an earlier
    version: a label that still carries the `IL/` prefix loses it, and a label
    without a `type` becomes a detection label. Reads never write — the next
    save persists the normalised values.
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
        if isinstance(entry.get("label"), str):
            entry["label"] = strip_namespace(entry["label"].strip())
        if not entry.get("type"):
            entry["type"] = DEFAULT_TYPE
        data[index] = ordered(entry)
    return data


def save_labels(labels):
    STORE.write_text(
        json.dumps(labels, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def find(labels, label_id):
    """Resolve a label by its stable id. Names are never resolved here."""
    for entry in labels:
        if entry.get("id") == label_id:
            return entry
    raise ValidationError("no label with id %r (use list to find it)" % label_id)


# --- validation ------------------------------------------------------------


def validate(entry, existing, own_id=None):
    """Validate a complete label. Returns a cleaned copy in canonical order."""
    cleaned = {field: (entry.get(field) or "").strip() for field in COMMON_FIELDS}
    cleaned["type"] = cleaned["type"].lower()
    label_type = cleaned["type"]

    if not label_type:
        raise ValidationError(
            "type must not be empty — supported types: %s" % ", ".join(sorted(LABEL_TYPES))
        )
    if label_type not in LABEL_TYPES:
        raise ValidationError(
            "unknown label type %r — supported types: %s"
            % (label_type, ", ".join(sorted(LABEL_TYPES)))
        )

    if not cleaned["name"]:
        raise ValidationError("name must not be empty")

    label = cleaned["label"]
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
        if label.lower() == reserved.lower():
            raise ValidationError(
                "label %r resolves to %s, which is reserved for %s — choose a different label"
                % (label, gmail_label(reserved), purpose)
            )

    for field in LABEL_TYPES[label_type]["fields"]:
        value = (entry.get(field) or "").strip()
        if not value:
            raise ValidationError("%s must not be empty for a %s label" % (field, label_type))
        cleaned[field] = value

    for other in existing:
        if other.get("id") != own_id and other.get("name", "").lower() == cleaned["name"].lower():
            raise ValidationError("a label named %r already exists" % other["name"])

    return ordered(cleaned)


# --- operations ------------------------------------------------------------


def list_labels():
    return load_labels()


def get_label(label_id):
    return find(load_labels(), label_id)


def create_label(name, label, instruction, label_type=DEFAULT_TYPE):
    labels = load_labels()
    cleaned = validate(
        {"name": name, "label": label, "type": label_type, "instruction": instruction},
        labels,
    )
    entry = ordered(dict(cleaned, id=uuid.uuid4().hex[:8]))
    labels.append(entry)
    save_labels(labels)
    return entry


def update_label(label_id, name=None, label=None, instruction=None, label_type=None):
    changes = {"name": name, "label": label, "instruction": instruction, "type": label_type}
    if all(value is None for value in changes.values()):
        raise ValidationError(
            "nothing to update: pass --name, --label, --type or --instruction"
        )
    labels = load_labels()
    entry = find(labels, label_id)
    merged = dict(entry)
    merged.update({field: value for field, value in changes.items() if value is not None})
    cleaned = validate(merged, labels, own_id=entry.get("id"))
    label_id = entry["id"]
    entry.clear()
    entry.update(ordered(dict(cleaned, id=label_id)))
    save_labels(labels)
    return entry


def delete_label(label_id):
    labels = load_labels()
    entry = find(labels, label_id)
    labels.remove(entry)
    save_labels(labels)
    return entry


# --- cli -------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(description="Manage Inbox Labeler labels.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="list all labels")

    show = sub.add_parser("get", help="show one label")
    show.add_argument("id", help="label id (not the name)")

    type_help = "label type (default: %s — %s)" % (
        DEFAULT_TYPE,
        ", ".join(sorted(LABEL_TYPES)),
    )

    create = sub.add_parser("create", help="create a label")
    create.add_argument("--name", required=True)
    create.add_argument(
        "--label",
        required=True,
        help="logical label without the IL/ prefix, e.g. Invoices (becomes IL/Invoices in Gmail)",
    )
    create.add_argument(
        "--instruction", required=True, help="how Claude decides whether the label applies"
    )
    create.add_argument("--type", default=DEFAULT_TYPE, help=type_help)

    update = sub.add_parser("update", help="update a label")
    update.add_argument("id", help="label id (not the name)")
    update.add_argument("--name")
    update.add_argument("--label", help="logical label without the IL/ prefix")
    update.add_argument("--instruction")
    update.add_argument("--type", help=type_help)

    delete = sub.add_parser("delete", help="delete a label")
    delete.add_argument("id", help="label id (not the name)")

    args = parser.parse_args(argv)

    try:
        if args.command == "list":
            result = list_labels()
        elif args.command == "get":
            result = get_label(args.id)
        elif args.command == "create":
            result = create_label(args.name, args.label, args.instruction, args.type)
        elif args.command == "update":
            result = update_label(args.id, args.name, args.label, args.instruction, args.type)
        else:
            result = delete_label(args.id)
    except ValidationError as exc:
        print(json.dumps({"error": str(exc)}, indent=2))
        return 1

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
