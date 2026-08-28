import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { callerBucket } from "./rate-limit.ts";

/**
 * How a caller is turned into a bucket, and whose word is taken for who they are.
 *
 * Three properties, and they pull against each other, which is why they are
 * written down:
 *
 *   1. the limiter needs one caller to land in one bucket every time
 *   2. the row it writes must not say which caller that was — the bucket is a
 *      primary key in `oauth_rate_limits`, so it is the record of who visited
 *   3. **nothing a request carries may buy the sender a bucket of their own**
 *
 * The third is the one with an attacker in it. A request header is written by
 * whoever sends the request, so a limiter that identifies callers by reading one
 * has as many identities as the sender cares to type — and a rate limit with
 * unlimited identities is not a rate limit. The answer here is not a different
 * header: it is that a header is only believed where the platform is documented to
 * have overwritten it, and `process.env.VERCEL` — an environment variable the
 * platform sets, not something a request can carry — is how that is known.
 *
 * Both modes are exercised below, because both ship: the trusted one is
 * production, and the shared one is a laptop, a self-hosted box, or anything with
 * a proxy in front that this reasoning does not cover.
 */

const KEY = new TextEncoder().encode("a-test-signing-key-of-at-least-32-bytes");
const OTHER_KEY = new TextEncoder().encode("a-different-key-of-at-least-32-bytes!!");

function from(address: string | null): Request {
  return new Request("http://localhost:3000/oauth/authorize", {
    headers: address === null ? {} : { "x-forwarded-for": address },
  });
}

/** Runs `work` as though the trusted ingress were, or were not, in front. */
function behindIngress<T>(trusted: boolean, work: () => T): T {
  const before = process.env.VERCEL;
  if (trusted) process.env.VERCEL = "1";
  else delete process.env.VERCEL;
  try {
    return work();
  } finally {
    if (before === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = before;
  }
}

const trusted = <T,>(work: () => T): T => behindIngress(true, work);
const untrusted = <T,>(work: () => T): T => behindIngress(false, work);

// --- behind the trusted ingress ---------------------------------------------

test("the same address maps to the same bucket every time", () => {
  trusted(() => {
    assert.equal(
      callerBucket("authorize", from("203.0.113.7"), KEY),
      callerBucket("authorize", from("203.0.113.7"), KEY),
    );
  });
});

test("different addresses stay independent", () => {
  trusted(() => {
    assert.notEqual(
      callerBucket("authorize", from("203.0.113.7"), KEY),
      callerBucket("authorize", from("203.0.113.8"), KEY),
    );
  });
});

test("the endpoints count separately for one address", () => {
  trusted(() => {
    const authorize = callerBucket("authorize", from("203.0.113.7"), KEY);
    const register = callerBucket("register", from("203.0.113.7"), KEY);
    const signin = callerBucket("signin", from("203.0.113.7"), KEY);

    assert.equal(new Set([authorize, register, signin]).size, 3);
    // The namespace is readable, which is what makes a row diagnosable; the
    // caller is not.
    assert.ok(authorize.startsWith("authorize:"));
    assert.ok(register.startsWith("register:"));
    assert.ok(signin.startsWith("signin:"));
  });
});

test("the bucket does not contain the address, in any form it arrives in", () => {
  trusted(() => {
    for (const address of ["203.0.113.7", "2001:db8::1", "203.0.113.7, 198.51.100.2"]) {
      for (const kind of ["authorize", "register", "signin"] as const) {
        const bucket = callerBucket(kind, from(address), KEY);

        for (const part of address.split(",").map((entry) => entry.trim())) {
          assert.equal(
            bucket.includes(part),
            false,
            `${kind} bucket for ${JSON.stringify(address)} contains ${part}`,
          );
        }
        assert.match(bucket, /^[a-z]+:([0-9a-f]{32}|shared)$/);
      }
    }
  });
});

test("the digest is keyed, not a bare hash of the address", () => {
  trusted(() => {
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
});

// --- forging a way out of the limit -----------------------------------------
//
// The whole point of the trust model. In each case the question is the same: can
// the sender obtain a bucket that is theirs alone, and therefore a fresh budget?

test("without the trusted ingress, no forwarded value buys a bucket of its own", () => {
  untrusted(() => {
    const attempts = [
      null,
      "203.0.113.7",
      "203.0.113.8",
      "10.0.0.1",
      "2001:db8::1",
      "203.0.113.7, 198.51.100.2",
      "not-an-address",
      "",
      "   ",
    ];

    const buckets = new Set(attempts.map((value) => callerBucket("register", from(value), KEY)));

    assert.equal(buckets.size, 1, "every attempt lands in one bucket");
    assert.deepEqual([...buckets], ["register:shared"]);
  });
});

test("a thousand invented addresses are still one bucket when nothing established them", () => {
  untrusted(() => {
    const buckets = new Set(
      Array.from({ length: 1000 }, (_, index) =>
        callerBucket("authorize", from(`198.51.100.${index % 256}.${index}`), KEY),
      ),
    );

    assert.equal(buckets.size, 1, "the budget cannot be multiplied by typing");
  });
});

test("behind the ingress, a forwarded *list* is refused rather than parsed", () => {
  trusted(() => {
    // Vercel overwrites the header with one address, so a list means something is
    // in front of the ingress that the guarantee does not cover. Taking the
    // left-most entry — the usual convention — would be exactly the spoofable
    // reading: the sender chooses what goes first.
    const shared = callerBucket("authorize", from("203.0.113.9"), KEY);
    assert.notEqual(shared, "authorize:shared");

    for (const list of ["203.0.113.9, 198.51.100.2", "198.51.100.2, 203.0.113.9", "a, b, c"]) {
      assert.equal(
        callerBucket("authorize", from(list), KEY),
        "authorize:shared",
        `${list} should not identify a caller`,
      );
    }
  });
});

test("behind the ingress, a request with no forwarded address shares the bucket", () => {
  trusted(() => {
    // Nothing established a caller, so there is no caller to count separately.
    assert.equal(callerBucket("authorize", from(null), KEY), "authorize:shared");
    assert.equal(callerBucket("authorize", from("  "), KEY), "authorize:shared");
  });
});

test("the shared bucket is a literal, not a digest of anything a request sent", () => {
  untrusted(() => {
    // It must not be derivable from the request at all: a shared bucket whose name
    // depended on an input would be a bucket per input under another name.
    for (const kind of ["authorize", "register", "signin"] as const) {
      assert.equal(callerBucket(kind, from("203.0.113.7"), KEY), `${kind}:shared`);
      // And it does not vary with the deployment secret, because there is nothing
      // secret about "we do not know who this is".
      assert.equal(callerBucket(kind, from("203.0.113.7"), OTHER_KEY), `${kind}:shared`);
    }
  });
});

test("the trust cannot be switched on by a request", () => {
  // The only thing that decides is an environment variable. There is no header,
  // path, method or body that reaches that decision — asserted by handing the
  // request every plausible attempt at one and getting the shared bucket back.
  untrusted(() => {
    const request = new Request("http://localhost:3000/oauth/register", {
      method: "POST",
      headers: {
        "x-forwarded-for": "203.0.113.7",
        "x-vercel-forwarded-for": "203.0.113.7",
        "x-vercel-id": "fra1::abc",
        "x-real-ip": "203.0.113.7",
        "x-vercel-deployment-url": "inboxlabeler.vercel.app",
        vercel: "1",
      },
    });

    assert.equal(callerBucket("register", request, KEY), "register:shared");
  });
});
