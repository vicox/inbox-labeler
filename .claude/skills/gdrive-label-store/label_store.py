#!/usr/bin/env python3
"""Google Drive Label Store — the deterministic half.

This skill manages the label definitions for the Inbox Labeler, kept in the
Google Drive folder `Inbox Labeler` as files named `labels.json`. The canonical
definitions are always the most recently modified one.

Drive itself is reached through the Drive connector's tools. This module owns
the two things that must be deterministic and testable:

    validate      is this a legal label document? — every error, not the first
    format        serialise to stable, human-readable JSON

It never talks to Drive, never touches Gmail, and knows nothing about email or
labelling behaviour. It reads and writes local files only.

Every command prints JSON to stdout and exits non-zero with {"ok": false, ...}
when the document is invalid.

Usage:
    label_store.py validate FILE
    label_store.py format FILE [--write]
"""

import argparse
import json
import sys
from pathlib import Path

# The canonical location in Drive. The folder is the product workspace and may
# gain further files later, so the folder is located first and the file second.
WORKSPACE_FOLDER = "Inbox Labeler"
LABELS_FILE = "labels.json"

# The label schema, mirrored from the Inbox Labeler skill. `fields` are required
# non-empty strings; `references` are lists of labels pointing at other labels.
LABEL_TYPES = {
    "detection": {"fields": ("instruction",), "references": ()},
    "derived": {
        "fields": ("instruction",),
        "references": ("required_labels", "recommended_labels"),
    },
}
COMMON_FIELDS = ("label", "type", "attention")

# What a label asks of the user, mirrored from the Inbox Labeler skill.
ATTENTION_LEVELS = ("none", "normal", "high")
REFERENCE_FIELDS = tuple(
    field for spec in LABEL_TYPES.values() for field in spec.get("references", ())
)
# References may only point at this type, matching the Inbox Labeler's own rule.
REFERENCEABLE_TYPE = "detection"

# Reserved by the Inbox Labeler for its own Gmail labels.
RESERVED_LABELS = ("processed", "no-match")

FIELD_ORDER = ("label", "type", "attention") + ("instruction",) + REFERENCE_FIELDS


class StoreError(Exception):
    pass


# --- reading ---------------------------------------------------------------


def read_document(path):
    """Read a labels document from disk. Raises on unreadable or invalid JSON."""
    file = Path(path)
    if not file.exists():
        raise StoreError("%s does not exist" % file)
    try:
        text = file.read_text(encoding="utf-8")
    except OSError as exc:
        raise StoreError("cannot read %s: %s" % (file, exc))
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise StoreError("%s is not valid JSON: %s" % (file.name, exc))


# --- validation ------------------------------------------------------------


def validate(document):
    """Check a labels document. Returns every problem found, never repairing.

    The checks are independent, so one broken label does not hide the next.
    """
    errors = []

    if not isinstance(document, list):
        return ["the document must be a JSON array of labels, not %s" % type_name(document)]

    seen = {}
    for index, entry in enumerate(document):
        where = "label %d" % (index + 1)
        if not isinstance(entry, dict):
            errors.append("%s must be a JSON object, not %s" % (where, type_name(entry)))
            continue

        label = entry.get("label")
        if not isinstance(label, str):
            errors.append("%s: label must be a string, not %s" % (where, type_name(label)))
        elif not label.strip():
            errors.append("%s: label must not be empty" % where)
        elif label != label.strip() or "  " in label:
            errors.append("%s: label %r has untrimmed or doubled whitespace" % (where, label))
        else:
            where = "label %r" % label
            key = label.strip().lower()
            if key in seen:
                errors.append(
                    "%s duplicates %r — labels identify case-insensitively"
                    % (where, seen[key])
                )
            else:
                seen[key] = label
            if key in RESERVED_LABELS:
                errors.append("%s is reserved for the Inbox Labeler's own state" % where)
            if label.lower().startswith("il/"):
                errors.append("%s must not carry the IL/ namespace prefix" % where)

        label_type = entry.get("type")
        if not isinstance(label_type, str):
            errors.append("%s: type must be a string, not %s" % (where, type_name(label_type)))
            continue
        if label_type not in LABEL_TYPES:
            errors.append(
                "%s: unknown type %r — types: %s"
                % (where, label_type, ", ".join(sorted(LABEL_TYPES)))
            )
            continue

        attention = entry.get("attention")
        if attention is not None:
            if not isinstance(attention, str):
                errors.append(
                    "%s: attention must be a string, not %s" % (where, type_name(attention))
                )
            elif attention.strip().lower() not in ATTENTION_LEVELS:
                errors.append(
                    "%s: unknown attention %r — levels: %s"
                    % (where, attention, ", ".join(ATTENTION_LEVELS))
                )

        spec = LABEL_TYPES[label_type]
        for field in spec["fields"]:
            value = entry.get(field)
            if not isinstance(value, str):
                errors.append(
                    "%s: %s must be a string, not %s" % (where, field, type_name(value))
                )
            elif not value.strip():
                errors.append("%s: %s must not be empty" % (where, field))

        for field in REFERENCE_FIELDS:
            value = entry.get(field)
            if field not in spec["references"]:
                if value:
                    errors.append(
                        "%s: %s applies only to derived labels" % (where, field)
                    )
                continue
            if field not in entry:
                errors.append("%s: %s is required on a derived label" % (where, field))
            elif not isinstance(value, list):
                errors.append(
                    "%s: %s must be an array, not %s" % (where, field, type_name(value))
                )
            elif any(not isinstance(ref, str) for ref in value):
                errors.append("%s: every %s entry must be a string" % (where, field))

        for field in set(entry) - set(FIELD_ORDER):
            errors.append("%s: unknown property %r" % (where, field))

    errors.extend(validate_references(document, seen))
    return errors


def validate_references(document, known):
    """Check that references resolve, point at a legal type, and form no cycle."""
    errors = []
    edges = {}

    for entry in document:
        if not isinstance(entry, dict) or not isinstance(entry.get("label"), str):
            continue
        label = entry["label"]
        spec = LABEL_TYPES.get(entry.get("type"), {})
        targets = []
        for field in spec.get("references", ()):
            for ref in entry.get(field) or []:
                if not isinstance(ref, str):
                    continue
                key = ref.strip().lower()
                if key not in known:
                    errors.append(
                        "label %r: %s references %r, which is not a label in this document"
                        % (label, field, ref)
                    )
                    continue
                target = next(
                    e for e in document
                    if isinstance(e, dict) and isinstance(e.get("label"), str)
                    and e["label"].strip().lower() == key
                )
                if target.get("type") != REFERENCEABLE_TYPE:
                    errors.append(
                        "label %r: %s references %r, which is a %s label — only %s labels "
                        "may be referenced"
                        % (label, field, target["label"], target.get("type"), REFERENCEABLE_TYPE)
                    )
                targets.append(key)
        edges[label.strip().lower()] = targets

    errors.extend(find_cycles(edges, known))
    return errors


def find_cycles(edges, known):
    """Report every reference cycle, each once, by walking the graph depth-first."""
    errors = []
    reported = set()
    state = {}

    def walk(node, path):
        state[node] = "open"
        for target in edges.get(node, ()):
            if state.get(target) == "open":
                cycle = path[path.index(target):] + [target]
                signature = frozenset(cycle)
                if signature not in reported:
                    reported.add(signature)
                    errors.append(
                        "circular dependency: %s"
                        % " -> ".join(known.get(step, step) for step in cycle)
                    )
            elif state.get(target) is None:
                walk(target, path + [target])
        state[node] = "closed"

    for node in edges:
        if state.get(node) is None:
            walk(node, [node])
    return errors


def type_name(value):
    return {
        type(None): "null", bool: "a boolean", int: "a number", float: "a number",
        str: "a string", list: "an array", dict: "an object",
    }.get(type(value), type(value).__name__)


# --- serialising -----------------------------------------------------------


def ordered(entry):
    """One label with its properties in canonical order."""
    result = {field: entry[field] for field in FIELD_ORDER if field in entry}
    result.update({k: v for k, v in entry.items() if k not in result})
    return result


def serialise(document):
    """Stable, human-readable JSON: same document in, same bytes out."""
    labels = [ordered(e) if isinstance(e, dict) else e for e in document]
    return json.dumps(labels, indent=2, ensure_ascii=False) + "\n"


# --- cli -------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Validate and serialise the Inbox Labeler label definitions."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    check = sub.add_parser("validate", help="check a labels document, reporting every problem")
    check.add_argument("file")

    fmt = sub.add_parser("format", help="serialise to stable, human-readable JSON")
    fmt.add_argument("file")
    fmt.add_argument("--write", action="store_true", help="rewrite the file in place")

    args = parser.parse_args(argv)

    try:
        document = read_document(args.file)
        if args.command == "validate":
            errors = validate(document)
            result = {
                "ok": not errors,
                "file": args.file,
                "labels": len(document) if isinstance(document, list) else None,
                "errors": errors,
            }
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 0 if not errors else 1
        errors = validate(document)
        if errors:
            raise StoreError("refusing to format an invalid document: %s" % errors[0])
        text = serialise(document)
        if not args.write:
            print(text, end="")
            return 0
        Path(args.file).write_text(text, encoding="utf-8")
        result = {"ok": True, "file": args.file, "labels": len(document)}
    except StoreError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, indent=2, ensure_ascii=False))
        return 1

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
