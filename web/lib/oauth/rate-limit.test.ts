import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { callerBucket } from "./rate-limit.ts";

/**
 * How a caller is turned into a bucket.
 *
 * The bucket is a primary key in `oauth_rate_limits`, so what it contains is
 * what the database keeps about who visited. These tests exist to hold two
 * properties that pull in opposite directions: the limiter needs one caller to
 * land in one bucket every time, and the row it writes must not say which
 * caller that was.
 */

const KEY = new TextEncoder().encode("a-test-signing-key-of-at-least-32-bytes");
const OTHER_KEY = new TextEncoder().encode("a-different-key-of-at-least-32-bytes!!");

function from(address: string | null): Request {
  return new Request("http://localhost:3000/oauth/authorize", {
    headers: address === null ? {} : { "x-forwarded-for": address },
  });
}

test("the same address maps to the same bucket every time", () => {
  const first = callerBucket("authorize", from("203.0.113.7"), KEY);
  const second = callerBucket("authorize", from("203.0.113.7"), KEY);

  assert.equal(first, second);
});

test("different addresses stay independent", () => {
  const one = callerBucket("authorize", from("203.0.113.7"), KEY);
  const two = callerBucket("authorize", from("203.0.113.8"), KEY);

  assert.notEqual(one, two);
});

test("the two endpoints count separately for one address", () => {
  const authorize = callerBucket("authorize", from("203.0.113.7"), KEY);
  const register = callerBucket("register", from("203.0.113.7"), KEY);

  assert.notEqual(authorize, register);
  // The namespace is readable, which is what makes a row diagnosable; the
  // caller is not.
  assert.ok(authorize.startsWith("authorize:"));
  assert.ok(register.startsWith("register:"));
});

test("the bucket does not contain the address, in any form it arrives in", () => {
  const addresses = [
    "203.0.113.7",
    "2001:db8::1",
    // The left-most entry is the caller; the rest are proxies and must not
    // appear either.
    "203.0.113.7, 198.51.100.2, 192.0.2.3",
  ];

  for (const address of addresses) {
    for (const kind of ["authorize", "register"] as const) {
      const bucket = callerBucket(kind, from(address), KEY);

      for (const part of address.split(",").map((entry) => entry.trim())) {
        assert.equal(
          bucket.includes(part),
          false,
          `${kind} bucket for ${JSON.stringify(address)} contains ${part}`,
        );
      }
      assert.equal(bucket, `${kind}:${bucket.slice(kind.length + 1)}`);
      assert.match(bucket.slice(kind.length + 1), /^[0-9a-f]{32}$/);
    }
  }
});

test("the left-most forwarded entry is still what identifies the caller", () => {
  // The semantics the limiter had before the digest: the platform's view of the
  // caller, not whatever a proxy chain appended.
  const direct = callerBucket("authorize", from("203.0.113.7"), KEY);
  const chained = callerBucket("authorize", from("203.0.113.7, 198.51.100.2"), KEY);

  assert.equal(direct, chained);
});

test("a request with no forwarded address is still counted, and consistently", () => {
  const first = callerBucket("authorize", from(null), KEY);
  const second = callerBucket("authorize", from(null), KEY);

  assert.equal(first, second);
  assert.notEqual(first, callerBucket("authorize", from("203.0.113.7"), KEY));
});

test("the digest is keyed, not a bare hash of the address", () => {
  const address = "203.0.113.7";

  // A different deployment secret gives a different bucket. A plain hash could
  // not do this, and it is what stops the table from being reversible by
  // hashing every address in the space.
  assert.notEqual(
    callerBucket("authorize", from(address), KEY),
    callerBucket("authorize", from(address), OTHER_KEY),
  );

  const bare = createHash("sha256").update(address).digest("hex");
  assert.equal(callerBucket("authorize", from(address), KEY).includes(bare.slice(0, 32)), false);
});
