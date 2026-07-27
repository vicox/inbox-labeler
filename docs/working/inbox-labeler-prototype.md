# Inbox Labeler — Minimal Local Prototype

Build a minimal local prototype of **Inbox Labeler**.

## Goal

Create a local Claude Agent Skill that allows a user to define persistent label requests and later run the skill to apply those requests to inbox emails.

A label request describes:

- what the request is called
- which Gmail label should be applied
- how Claude should decide whether an email matches

The prototype should focus only on storing and managing these requests locally. Keep everything inside one project folder.

## Label Request

A label request consists of:

- `name`
- `label`
- `instruction`

## Required operations

Implement:

- `create_label_request`
- `update_label_request`
- `delete_label_request`
- `list_label_requests`

Each operation must read from or write to a local `label-requests.json` file.

Validate label requests before saving them.

At minimum:

- `name` must not be empty
- `label` must not be empty and should use the `IL/` namespace
- `instruction` must not be empty
- every label request must have a stable identifier so it can be updated or deleted reliably

Create the JSON file automatically if it does not exist.

## Skill

Add a `SKILL.md` that explains how Claude should use the available operations.

The skill should support two situations:

1. The user asks to create, change, delete, or list label requests.
2. The user manually asks Inbox Labeler to process the inbox. In that case, Claude should load all label requests and use their instructions to decide which labels apply to new emails.

The actual Gmail integration does not need to be implemented in this first version unless it is already available through Claude tools. The skill should only describe the intended inbox-processing behavior.

## Constraints

Keep the implementation deliberately small and local.

Do not add:

- a database
- a remote API
- authentication
- a web server
- a scheduler
- a UI
- unnecessary abstractions

Use a simple project structure with:

- `SKILL.md`
- the CRUD implementation
- `label-requests.json`
- a short README explaining how to run and test it

Prioritize a working, understandable prototype over a production-ready architecture.
