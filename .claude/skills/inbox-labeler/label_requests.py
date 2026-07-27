#!/usr/bin/env python3
"""Inbox Labeler — local CRUD for label requests.

A label request is {id, name, label, instruction}. They live in
label-requests.json next to this script. Every command prints JSON to stdout
and exits non-zero with {"error": ...} when something is wrong.

Usage:
    label_requests.py list
    label_requests.py create --name NAME --label IL/LABEL --instruction TEXT
    label_requests.py update ID [--name NAME] [--label IL/LABEL] [--instruction TEXT]
    label_requests.py delete ID

update and delete take the label request id only — never the name. Use list to
look up the id belonging to a name.
"""

import argparse
import json
import sys
import uuid
from pathlib import Path

STORE = Path(__file__).resolve().parent / "label-requests.json"
LABEL_NAMESPACE = "IL/"


class ValidationError(Exception):
    pass


# --- storage ---------------------------------------------------------------


def load_label_requests():
    """Read all label requests, creating an empty store if needed."""
    if not STORE.exists():
        save_label_requests([])
        return []
    try:
        data = json.loads(STORE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValidationError("%s is not valid JSON: %s" % (STORE.name, exc))
    if not isinstance(data, list):
        raise ValidationError("%s must contain a JSON array" % STORE.name)
    return data


def save_label_requests(label_requests):
    STORE.write_text(
        json.dumps(label_requests, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def find(label_requests, request_id):
    """Resolve a label request by its stable id. Names are never resolved here."""
    for entry in label_requests:
        if entry.get("id") == request_id:
            return entry
    raise ValidationError("no label request with id %r (use list to find it)" % request_id)


# --- validation ------------------------------------------------------------


def validate(name, label, instruction, label_requests, own_id=None):
    """Validate a complete label request. Returns cleaned field values."""
    name = (name or "").strip()
    label = (label or "").strip()
    instruction = (instruction or "").strip()

    if not name:
        raise ValidationError("name must not be empty")
    if not label:
        raise ValidationError("label must not be empty")
    if not label.startswith(LABEL_NAMESPACE) or not label[len(LABEL_NAMESPACE):].strip():
        raise ValidationError(
            "label must use the %s namespace, e.g. %sNewsletter" % (LABEL_NAMESPACE, LABEL_NAMESPACE)
        )
    if not instruction:
        raise ValidationError("instruction must not be empty")

    for entry in label_requests:
        if entry.get("id") != own_id and entry.get("name", "").lower() == name.lower():
            raise ValidationError("a label request named %r already exists" % entry["name"])

    return name, label, instruction


# --- operations ------------------------------------------------------------


def list_label_requests():
    return load_label_requests()


def create_label_request(name, label, instruction):
    label_requests = load_label_requests()
    name, label, instruction = validate(name, label, instruction, label_requests)
    entry = {
        "id": uuid.uuid4().hex[:8],
        "name": name,
        "label": label,
        "instruction": instruction,
    }
    label_requests.append(entry)
    save_label_requests(label_requests)
    return entry


def update_label_request(request_id, name=None, label=None, instruction=None):
    if name is None and label is None and instruction is None:
        raise ValidationError("nothing to update: pass --name, --label or --instruction")
    label_requests = load_label_requests()
    entry = find(label_requests, request_id)
    name, label, instruction = validate(
        name if name is not None else entry.get("name"),
        label if label is not None else entry.get("label"),
        instruction if instruction is not None else entry.get("instruction"),
        label_requests,
        own_id=entry.get("id"),
    )
    entry.update(name=name, label=label, instruction=instruction)
    save_label_requests(label_requests)
    return entry


def delete_label_request(request_id):
    label_requests = load_label_requests()
    entry = find(label_requests, request_id)
    label_requests.remove(entry)
    save_label_requests(label_requests)
    return entry


# --- cli -------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(description="Manage Inbox Labeler label requests.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="list all label requests")

    create = sub.add_parser("create", help="create a label request")
    create.add_argument("--name", required=True)
    create.add_argument("--label", required=True, help="Gmail label, must start with IL/")
    create.add_argument("--instruction", required=True, help="how Claude decides whether an email matches")

    update = sub.add_parser("update", help="update a label request")
    update.add_argument("id", help="label request id (not the name)")
    update.add_argument("--name")
    update.add_argument("--label")
    update.add_argument("--instruction")

    delete = sub.add_parser("delete", help="delete a label request")
    delete.add_argument("id", help="label request id (not the name)")

    args = parser.parse_args(argv)

    try:
        if args.command == "list":
            result = list_label_requests()
        elif args.command == "create":
            result = create_label_request(args.name, args.label, args.instruction)
        elif args.command == "update":
            result = update_label_request(args.id, args.name, args.label, args.instruction)
        else:
            result = delete_label_request(args.id)
    except ValidationError as exc:
        print(json.dumps({"error": str(exc)}, indent=2))
        return 1

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
