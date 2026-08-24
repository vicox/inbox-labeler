import { createHmac } from "node:crypto";

/**
 * Who an authenticated request belongs to.
 *
 * This is the whole identity model, deliberately: one stable id and nothing
 * else. Everything the OAuth layer learns about a person while authenticating
 * them — their email address, their profile, every claim in the identity
 * provider's token — stops at that layer. What crosses into InboxLabeler is
 * the single field that will later decide which labels and matches are theirs,
 * so it is the field that has to be stable across sessions and must never name
 * two different people.
 *
 * `id` is provider-qualified (`google:1234…`) rather than a bare subject. The
 * prefix is not decoration: it is what keeps two identity providers from ever
 * minting the same id for different people, which is the confusion this type
 * exists to prevent. To every reader it is an opaque key — nothing parses it,
 * and nothing should start.
 */
export type AuthenticatedUser = {
  id: string;
};

/**
 * A stable, non-reversible fingerprint of a user id, safe to hand to an MCP
 * client.
 *
 * Two different questions get two different answers here. Internally we want
 * the real id, because it has to key storage. Externally a client — and the
 * model reading its output — has no business knowing which Google account is
 * on the other end, so it gets a value that is only good for one thing:
 * telling two sessions apart, and telling the same user's two sessions
 * together. That is exactly what verifying per-user isolation needs and the
 * most that can be shown without leaking the account behind it.
 *
 * Keyed with the deployment secret rather than a bare hash, because a bare
 * hash of a Google subject is not private: subjects are short numeric strings,
 * so anyone could hash candidates until one matched. An HMAC cannot be
 * searched that way without the key. Truncated to 128 bits, which is far more
 * than enough to keep two users distinct and short enough to read in a log.
 */
export function userRef(user: AuthenticatedUser, key: Uint8Array): string {
  return createHmac("sha256", key).update(`inboxlabeler.user:${user.id}`).digest("hex").slice(0, 32);
}
