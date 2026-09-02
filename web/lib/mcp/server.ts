import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AuthenticatedUser } from "../identity.ts";
import { ATTENTION_LEVELS, DETECTION_ROLES, LABEL_TYPES, LabelError } from "../inbox/labels.ts";
import type { ProductStore } from "../inbox/store.ts";

/**
 * The MCP server InboxLabeler exposes, and the tools on it.
 *
 * Knows nothing about HTTP and nothing about SQL. It is handed an authenticated
 * user and a store already bound to them, and every tool is the same three
 * steps: the SDK validates the arguments against the schema, the store performs
 * the domain operation, the result is returned in both shapes a client might
 * read. No tool builds a query, and no tool decides who is asking.
 *
 * Whose state a tool touches is not something a tool can influence. The store
 * was opened for one user before this function was called and carries no
 * argument for a different one, so there is no `user_id` in any schema below and
 * nowhere for a client to put one. A malicious client's only move is to ask for
 * its own labels under another name, which is a label that does not exist.
 */

/** Named in `serverInfo`, and what a client shows the user. */
const SERVER_NAME = "InboxLabeler";

/**
 * The MCP server's own version, which is the protocol surface's version and not
 * the web application's.
 *
 * At 0.2 because the label and match tools are here now; still 0.x because
 * processing a mailbox — the part that puts labels on mail — is not.
 */
const SERVER_VERSION = "0.2.0";

/**
 * The session a server instance is built for.
 *
 * `reference` is the opaque fingerprint of the user, derived elsewhere so this
 * file needs neither the signing key nor the configuration. `store` is already
 * scoped to `user`: see `lib/inbox/store.ts` for why that is the isolation
 * mechanism rather than a check anything here performs.
 */
export type McpSession = {
  user: AuthenticatedUser;
  reference: string;
  store: ProductStore;
};

// --- shared field schemas --------------------------------------------------
//
// Described once, because the description is what a model reads to decide how to
// call a tool, and two tools disagreeing about what `label` means would be worse
// than either description being imperfect.

const labelText = z
  .string()
  .describe(
    'The label itself, a readable phrase that may contain spaces — "Delivery arriving soon". ' +
      "This is the label's only identifier; there is no separate name or id. Matched " +
      "case-insensitively. Never include the IL/ prefix: InboxLabeler adds that when it talks " +
      "to Gmail.",
  );

const instruction = z
  .string()
  .describe(
    "How to decide, in plain language, whether this label applies to a message. This is the " +
      "whole rule — it is read as a prompt, not matched as a pattern.",
  );

const labelType = z
  .enum(LABEL_TYPES)
  .describe(
    "How the label decides. 'detection' inspects an email directly. 'derived' interprets the " +
      "email together with the detection labels that already matched it, which it names in " +
      "required_labels and recommended_labels. A label's type cannot be changed later.",
  );

const detectionRole = z
  .enum(DETECTION_ROLES)
  .describe(
    "Detection labels only, and required when creating one. What kind of fact the label " +
      "detects: 'category' is what kind or domain of email this is (Invoice, Delivery, " +
      "Newsletter, Travel); 'attribute' is what the email contains, indicates or requires " +
      "(Action required, Question, Deadline, Large amount). Neither is exclusive — one email " +
      "may match several categories and several attributes — and the role does not affect " +
      "whether a label matches, only how the fact reads. May be changed later, unlike type.",
  );

const attention = z
  .enum(ATTENTION_LEVELS)
  .describe(
    "What the label asks of the user, separately from what it means: 'high' stars the message, " +
      "'none' marks it read once it is a day old, 'normal' asks for nothing. Defaults to normal.",
  );

const requiredLabels = z
  .array(z.string())
  .describe(
    "Derived labels only: the exact texts of detection labels that must ALL have matched before " +
      "this label is evaluated. This is the gate. Passing it replaces the stored list.",
  );

const recommendedLabels = z
  .array(z.string())
  .describe(
    "Derived labels only: the exact texts of detection labels offered as context when they " +
      "matched. The label is still evaluated when they did not. Passing it replaces the stored list.",
  );

/**
 * Builds a server bound to one authenticated user.
 *
 * A fresh instance per request, which is what the SDK's per-request factory
 * expects and what makes the binding trustworthy: the session is captured in
 * this closure, so a tool cannot read a different one and there is no shared
 * instance whose identity could be left over from the previous caller.
 */
export function inboxLabelerMcpServer(session: McpSession): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const { store } = session;

  server.registerTool(
    "get_server_info",
    {
      title: "Server information",
      description:
        "Reports that InboxLabeler's MCP endpoint is reachable and that this session is authenticated. Takes no arguments and reads nothing.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      // `authenticated` is a constant, and that is the honest answer rather than
      // a stub: this code is only reachable through the bearer gate, so by the
      // time it runs the question has been settled. `user` is the opaque
      // reference, never the account, the address or any claim.
      answer({
        name: SERVER_NAME,
        version: SERVER_VERSION,
        authenticated: true,
        user: session.reference,
      }),
  );

  server.registerTool(
    "get_labels",
    {
      title: "List labels",
      description:
        "Every label this user has defined: its text, type, attention level, instruction, the " +
        "role for a detection label, and — for derived labels — the detection labels it builds " +
        "on. A user who has defined none gets an empty list, which is the normal state for a new " +
        "account. A detection label created before roles existed has no role field; that means " +
        "nobody has decided whether it is a category or an attribute, not that it is broken.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => attempt(async () => ({ labels: await store.labels() })),
  );

  server.registerTool(
    "create_label",
    {
      title: "Create a label",
      description:
        "Define a new label. The label text must be unique for this user, ignoring case. " +
        "Detection labels are the default and read an email directly; a derived label needs " +
        "type 'derived' and names existing detection labels in required_labels. Reference lists " +
        "may only name detection labels — there is no chaining from one derived label to another. " +
        "A detection label must also say whether its fact is a category or an attribute; a " +
        "derived label must not, because it is already an interpretation of detection facts.",
      inputSchema: z.object({
        label: labelText,
        instruction,
        type: labelType.optional(),
        role: detectionRole.optional(),
        attention: attention.optional(),
        required_labels: requiredLabels.optional(),
        recommended_labels: recommendedLabels.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => attempt(async () => ({ label: await store.createLabel(args) })),
  );

  server.registerTool(
    "update_label",
    {
      title: "Update a label",
      description:
        "Change a label. Pass new_label to rename it — every reference to it from other labels, " +
        "and its whole match history, follow the new name in one step. A label's type is " +
        "immutable, but a detection label's role is not: pass role to give one to a label that " +
        "has none, or to change a category into an attribute or back. Leaving role out changes " +
        "nothing about it, so a label from before roles existed can be edited without being " +
        "given one. Passing required_labels or recommended_labels replaces the stored list rather " +
        "than adding to it, so an empty array clears it.",
      inputSchema: z.object({
        label: labelText.describe(
          "The label to change, by its current text. Matched case-insensitively.",
        ),
        new_label: labelText
          .describe("Rename the label to this text. Its references and match history follow it.")
          .optional(),
        instruction: instruction.optional(),
        type: labelType.optional(),
        role: detectionRole.optional(),
        attention: attention.optional(),
        required_labels: requiredLabels.optional(),
        recommended_labels: recommendedLabels.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ label, new_label: renamed, ...changes }) =>
      attempt(async () => ({
        label: await store.updateLabel(label, { ...changes, label: renamed }),
      })),
  );

  server.registerTool(
    "delete_label",
    {
      title: "Delete a label",
      description:
        "Remove a label and its match history together. Refused while another label references " +
        "it in required_labels or recommended_labels: drop the reference, or delete that label " +
        "first. Mail already labelled in Gmail is not touched — nothing revisits it.",
      inputSchema: z.object({ label: labelText }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ label }) => attempt(async () => ({ deleted: await store.deleteLabel(label) })),
  );

  server.registerTool(
    "get_matches",
    {
      title: "Read match history",
      description:
        "How often each label has matched. Per label: the newest email timestamp it has matched, " +
        "and a count per UTC calendar day. Days with no matches are absent. Give a label to read " +
        "just that one, where a label that has never matched reads as an empty history rather " +
        "than an error. Nothing about any individual message is recorded or available.",
      inputSchema: z.object({
        label: labelText
          .describe("Read only this label's history. Omit for every label that has ever matched.")
          .optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ label }) =>
      attempt(async () => ({
        matches: label === undefined ? await store.matches() : await store.matchesFor(label),
      })),
  );

  server.registerTool(
    "get_representative_labels",
    {
      title: "Pick each email's representative label",
      description:
        "For each already-processed email, which ONE of the labels on it represents it, which " +
        "are secondary, and which this account no longer defines. Pass the labels a processing " +
        "run already applied; this classifies nothing, reads no mail and writes nothing. The " +
        "choice is a deterministic ranking over the labels, the current label model and the " +
        "match history — not a judgement — so use it instead of deciding which label matters " +
        "most, which would give a different answer each run.",
      inputSchema: z.object({
        emails: z
          .array(
            z
              .array(z.string())
              .describe("One email: the exact texts of the labels that matched it."),
          )
          .describe(
            "One entry per email, answered in the same order. Each entry holds only label " +
              "texts, with or without the IL/ prefix; processed and no-match are ignored. Pass " +
              "nothing about the message — no id, no subject, no sender, no snippet, no body.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ emails }) =>
      attempt(async () => ({ emails: await store.representativeLabels(emails) })),
  );

  server.registerTool(
    "record_matches",
    {
      title: "Record matches",
      description:
        "Record that an email matched these labels. email_timestamp is THE EMAIL'S OWN timestamp, " +
        "never the time you are calling this: processing an old message must raise that old day's " +
        "count. It needs a UTC offset ('2026-08-20T10:12:00Z' or '2026-08-20T12:12:00+02:00'), " +
        "because without one the day it counts towards would be a guess. All the labels are " +
        "recorded together or none is. Only a day and a count are stored — never anything that " +
        "identifies the message.",
      inputSchema: z.object({
        labels: z
          .array(z.string())
          .describe(
            "The exact texts of the labels this one email matched. Each is one match; naming the " +
              "same label twice is refused.",
          ),
        email_timestamp: z
          .string()
          .describe(
            "The email's own ISO 8601 timestamp, with a UTC offset. Not the current time.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ labels, email_timestamp: at }) =>
      attempt(() => store.recordMatches(labels, at)),
  );

  return server;
}

/**
 * One result, in both shapes a client might read.
 *
 * `structuredContent` is what a client that understands it should use;
 * the JSON in `content` is what one that does not will show the model instead.
 * Both are the same value, so the two kinds of client see the same answer.
 */
function answer(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/**
 * Runs a store operation, turning a rejected label into a result rather than a
 * failure.
 *
 * A tool error, not a protocol error: the call reached the tool and the tool
 * answered, so the caller gets the reason in a form it can read and act on —
 * "that label already exists" is guidance a model can correct for, not a
 * transport problem. Anything that is not a `LabelError` is ours rather than the
 * caller's and is left to the SDK, which answers it without describing our
 * internals or leaking what the database said.
 */
async function attempt(work: () => Promise<unknown>) {
  try {
    return answer(await work());
  } catch (error) {
    if (!(error instanceof LabelError)) throw error;
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: error.message }],
    };
  }
}
