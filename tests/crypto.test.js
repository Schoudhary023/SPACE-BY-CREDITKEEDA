const test = require("node:test");
const assert = require("node:assert/strict");

test("encrypt and decrypt round-trip with the same pin", async () => {
  process.env.ENCRYPTION_SECRET = "test-secret";
  delete require.cache[require.resolve("../lib/crypto")];
  const { encrypt, decrypt } = require("../lib/crypto");

  const encrypted = await encrypt("gift-code-123", "4321", "123456789");
  assert.equal(await decrypt(encrypted, "4321", "123456789"), "gift-code-123");
});

test("runtime encryption round-trips with the app secret", () => {
  process.env.ENCRYPTION_SECRET = "test-secret";
  delete require.cache[require.resolve("../lib/crypto")];
  const { encryptForRuntime, decryptForRuntime } = require("../lib/crypto");

  const encrypted = encryptForRuntime("pending-save-payload");
  assert.equal(decryptForRuntime(encrypted), "pending-save-payload");
});
