import { assertEquals } from "@std/assert";
import { buildExecPath } from "../lib/exec-env.ts";

// ─── buildExecPath ─────────────────────────────────────────────

Deno.test("buildExecPath: undefined PATH → just the two Homebrew prefixes", () => {
  assertEquals(
    buildExecPath(undefined),
    "/opt/homebrew/bin:/usr/local/bin",
  );
});

Deno.test("buildExecPath: existing PATH with neither prefix → both prepended in order", () => {
  assertEquals(
    buildExecPath("/usr/bin:/bin:/usr/sbin:/sbin"),
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  );
});

Deno.test("buildExecPath: one prefix already present → only missing one prepended", () => {
  assertEquals(
    buildExecPath("/usr/local/bin:/usr/bin:/bin"),
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
  );
  assertEquals(
    buildExecPath("/opt/homebrew/bin:/usr/bin:/bin"),
    "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
  );
});

Deno.test("buildExecPath: both prefixes already present → PATH returned unchanged", () => {
  const original = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  assertEquals(buildExecPath(original), original);
});

Deno.test("buildExecPath: both prefixes present in different positions → no duplicates", () => {
  const original = "/usr/bin:/opt/homebrew/bin:/bin:/usr/local/bin";
  assertEquals(buildExecPath(original), original);
});
