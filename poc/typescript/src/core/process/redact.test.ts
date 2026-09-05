import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redactObject, redactSecrets } from "./redact.ts";

test("redacts GitHub and provider token prefixes", () => {
  assert.equal(redactSecrets("token: ghp_abcdefghijklmnopqrstuvwxyz"), "token: [REDACTED]");
  assert.equal(redactSecrets("key sk-ant-abcdefghijklmnop123456"), "key [REDACTED]");
});

test("redacts an Authorization header while keeping the scheme text out of the match", () => {
  const result = redactSecrets("Authorization: Bearer abcdef.ghijkl.mnopqr");
  assert.equal(result, "Authorization: Bearer [REDACTED]");
});

test("redacts a JSON key/value pair that looks like a credential", () => {
  const result = redactSecrets('{"apiKey": "super-secret-value"}');
  assert.equal(result, '{"apiKey": "[REDACTED]"}');
});

test("redacts a plain key=value credential pair", () => {
  assert.equal(redactSecrets("password=hunter2 next=ok"), "password=[REDACTED] next=ok");
});

test("passes null through untouched", () => {
  assert.equal(redactSecrets(null), null);
});

test("leaves ordinary text untouched", () => {
  assert.equal(redactSecrets("hello world, nothing secret here"), "hello world, nothing secret here");
});

test("redactObject redacts values under credential-shaped keys and recurses", () => {
  const input = {
    token: "abc123",
    nested: { password: "hunter2", ok: "fine" },
    list: [{ secret: "x" }, "plain"],
  };
  assert.deepEqual(redactObject(input), {
    token: "[REDACTED]",
    nested: { password: "[REDACTED]", ok: "fine" },
    list: [{ secret: "[REDACTED]" }, "plain"],
  });
});
