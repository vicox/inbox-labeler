import assert from "node:assert/strict";
import test from "node:test";

import { AccessDeniedError, allowlist, requireAllowed } from "./access.ts";
import { identityFromClaims } from "./google.ts";
import { IdentityError } from "./google.ts";
import { identifyUser, type IdentityProvider } from "./provider.ts";

/**
 * Who may sign in to this deployment.
 *
 * Two questions, asked in order and easy to conflate. The first is whether Google
 * established an address at all — an unverified one is not evidence of anything,
 * because it is an address the account holder typed rather than proved. The second
 * is whether that address is on the list this deployment was configured with.
 *
 * The invariant running through all of it: the address decides access and the
 * subject decides identity. A test that found an address where a user id belongs
 * would be finding a bug.
 */

/** Runs `work` with `ALLOWED_EMAILS` set to `value`, or unset when null. */
async function withAllowlist<T>(value: string | null, work: () => T | Promise<T>): Promise<T> {
  const before = process.env.ALLOWED_EMAILS;
  if (value === null) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = value;
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.ALLOWED_EMAILS;
    else process.env.ALLOWED_EMAILS = before;
  }
}

/** The refusal a call came back with, or "allowed". */
async function outcome(work: () => unknown): Promise<string> {
  try {
    await work();
    return "allowed";
  } catch (error) {
    if (error instanceof AccessDeniedError || error instanceof IdentityError) return error.message;
    throw error;
  }
}

// --- the list itself -------------------------------------------------------

test("an address on the list may sign in", async () => {
  const allowed = await withAllowlist("georg@example.com,someone@example.com", () =>
    outcome(() => requireAllowed("georg@example.com")),
  );

  assert.equal(allowed, "allowed");
});

test("an address that is not on the list may not", async () => {
  const refused = await withAllowlist("georg@example.com", () =>
    outcome(() => requireAllowed("stranger@example.com")),
  );

  assert.match(refused, /not on this deployment's access list/);
});

test("case and surrounding space do not decide access", async () => {
  // Both sides are normalised, because nobody writing a list by hand expects
  // otherwise and no provider treats the local part as case-sensitive in practice.
  await withAllowlist(" Georg@Example.COM , other@example.com ", async () => {
    assert.equal(await outcome(() => requireAllowed("georg@example.com")), "allowed");
    assert.equal(await outcome(() => requireAllowed("GEORG@EXAMPLE.COM")), "allowed");
    assert.equal(await outcome(() => requireAllowed("  georg@example.com  ")), "allowed");
    assert.equal(await outcome(() => requireAllowed("Other@Example.com")), "allowed");
  });
});

test("a near miss is a miss", async () => {
  await withAllowlist("georg@example.com", async () => {
    for (const address of [
      "georg@example.co",
      "georg@example.com.evil.test",
      "ageorg@example.com",
      "georg+beta@example.com",
      "",
    ]) {
      assert.notEqual(await outcome(() => requireAllowed(address)), "allowed", address);
    }
  });
});

// --- no list means no restriction -----------------------------------------

test("an unset list allows anyone, which is what a local checkout wants", async () => {
  const allowed = await withAllowlist(null, () => outcome(() => requireAllowed("anyone@example.com")));

  assert.equal(allowed, "allowed");
  assert.equal(await withAllowlist(null, allowlist), null);
});

test("an empty or blank list is the same as no list, not a locked door", async () => {
  // A variable set to "" or " , , " is somebody who has not decided yet. Reading
  // it as "nobody" would lock the operator out of their own deployment, which is
  // never what an empty string was trying to say.
  for (const written of ["", "   ", ",", " , , "]) {
    assert.equal(
      await withAllowlist(written, () => outcome(() => requireAllowed("anyone@example.com"))),
      "allowed",
      JSON.stringify(written),
    );
    assert.equal(await withAllowlist(written, allowlist), null, JSON.stringify(written));
  }
});

test("the parsed list drops blanks and keeps the rest", async () => {
  assert.deepEqual(
    await withAllowlist("a@example.com, ,B@Example.com ,", allowlist),
    ["a@example.com", "b@example.com"],
  );
});

// --- what Google has to have said -----------------------------------------

const CLAIMS = {
  sub: "112233445566778899",
  nonce: "the-nonce",
  email: "georg@example.com",
  email_verified: true,
};

test("a verified identity yields the subject as the id and the address beside it", () => {
  const identity = identityFromClaims(CLAIMS, "the-nonce");

  assert.deepEqual(identity, {
    user: { id: "google:112233445566778899" },
    email: "georg@example.com",
  });
});

test("the address is normalised on the way in", () => {
  const identity = identityFromClaims({ ...CLAIMS, email: "  Georg@Example.COM " }, "the-nonce");

  assert.equal(identity.email, "georg@example.com");
});

test("an identity with no address is refused", async () => {
  for (const email of [undefined, null, "", "   ", 42]) {
    assert.match(
      await outcome(() => identityFromClaims({ ...CLAIMS, email }, "the-nonce")),
      /carried no email address/,
      String(email),
    );
  }
});

test("an unverified address is refused", async () => {
  // Not evidence of anything: an unverified address is one the account holder
  // typed, so an allowlist checked against it is one anyone could join.
  for (const verified of [false, undefined, null, "true", 1]) {
    assert.match(
      await outcome(() => identityFromClaims({ ...CLAIMS, email_verified: verified }, "the-nonce")),
      /has not verified this account's email address/,
      String(verified),
    );
  }
});

test("the subject is still required, and still what becomes the id", async () => {
  assert.match(
    await outcome(() => identityFromClaims({ ...CLAIMS, sub: undefined }, "the-nonce")),
    /carried no subject/,
  );
  assert.equal(
    identityFromClaims({ ...CLAIMS, sub: "999" }, "the-nonce").user.id,
    "google:999",
    "the id is the subject, never the address",
  );
});

test("a token for a different login is still refused", async () => {
  assert.match(
    await outcome(() => identityFromClaims(CLAIMS, "a-different-nonce")),
    /belongs to a different login/,
  );
});

// --- the boundary ----------------------------------------------------------
//
// Where the two questions are asked together, and the only thing that comes out
// the other side is an identity.

/** A provider that establishes whatever the test says it does. */
function providerReturning(email: string, id = "google:1"): IdentityProvider {
  return {
    name: "stub",
    authorizationUrl: () => "https://example.test/authorize",
    identify: async () => ({ user: { id }, email }),
  };
}

const RESPONSE = { code: "c", redirectUri: "https://example.test/cb", codeVerifier: "v", nonce: "n" };

test("the boundary returns the identity for an allowed address", async () => {
  const user = await withAllowlist("georg@example.com", () =>
    identifyUser(RESPONSE, providerReturning("georg@example.com", "google:abc")),
  );

  assert.deepEqual(user, { id: "google:abc" }, "the identity, and only the identity");
});

test("the boundary refuses an address that is not allowed", async () => {
  const refused = await withAllowlist("georg@example.com", () =>
    outcome(() => identifyUser(RESPONSE, providerReturning("stranger@example.com"))),
  );

  assert.match(refused, /not on this deployment's access list/);
});

test("the boundary matches case-insensitively too", async () => {
  const user = await withAllowlist("georg@example.com", () =>
    identifyUser(RESPONSE, providerReturning("GEORG@Example.com")),
  );

  assert.deepEqual(user, { id: "google:1" });
});

test("the address does not survive the boundary", async () => {
  const user = await withAllowlist("georg@example.com", () =>
    identifyUser(RESPONSE, providerReturning("georg@example.com")),
  );

  // The whole point of the split: what the rest of InboxLabeler receives is an
  // identity with one field, and that field is the subject.
  assert.deepEqual(Object.keys(user), ["id"]);
  assert.equal(JSON.stringify(user).includes("@"), false);
});

test("with no list configured the boundary lets anyone through", async () => {
  const user = await withAllowlist(null, () =>
    identifyUser(RESPONSE, providerReturning("anyone@example.com", "google:xyz")),
  );

  assert.deepEqual(user, { id: "google:xyz" });
});
