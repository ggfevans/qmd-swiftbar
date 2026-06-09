import { assertEquals } from "@std/assert";
import { detectFirstRunState } from "../lib/detect.ts";
import type { Config } from "../lib/types.ts";

// ─── Helpers ───────────────────────────────────────────────────

function makeConfig(): Config {
  return {
    qmd: {
      index_path: "/tmp/qmd-swiftbar-test/index.sqlite",
      daemon_url: "http://localhost:8181",
    },
    rollup: {
      freshness: { amber_hours: 24, red_days: 7 },
      coverage: { amber_percent: 95, red_percent: 50 },
      error_window: { red_hours: 1, amber_hours: 24 },
    },
    notifications: {
      on_daemon_crash: true,
      on_op_failure: true,
      on_path_unreachable: true,
      on_job_completion: false,
      on_threshold_breach: false,
    },
    ui: {
      collection_meta: "freshness",
      hide_obsidian_when_absent: true,
    },
    logs: {
      directory: "/tmp/qmd-swiftbar-test/logs",
      retain_per_action: 10,
    },
  };
}

type Probes = {
  hasQmdBinary: () => Promise<boolean>;
  canImportSdk: () => Promise<boolean>;
  indexExists: (path: string) => Promise<boolean>;
  listCollections: (
    path: string,
  ) => Promise<Array<{ name: string; doc_count: number }>>;
};

function makeProbes(overrides: Partial<Probes> = {}): Probes {
  return {
    hasQmdBinary: () => Promise.resolve(true),
    canImportSdk: () => Promise.resolve(true),
    indexExists: () => Promise.resolve(true),
    listCollections: () => Promise.resolve([{ name: "default", doc_count: 5 }]),
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────

Deno.test("detectFirstRunState: all conditions met → 'ok'", async () => {
  const result = await detectFirstRunState(makeConfig(), makeProbes());
  assertEquals(result, "ok");
});

Deno.test("detectFirstRunState: hasQmdBinary false → 'no-qmd'", async () => {
  const result = await detectFirstRunState(
    makeConfig(),
    makeProbes({ hasQmdBinary: () => Promise.resolve(false) }),
  );
  assertEquals(result, "no-qmd");
});

Deno.test("detectFirstRunState: canImportSdk false with index present → 'ok' (SDK optional)", async () => {
  // When the SDK can't import (Deno permission issues, runtime panic),
  // but the binary is found and the index exists, degrade optimistically
  // to 'ok' rather than 'no-collections'.
  const result = await detectFirstRunState(
    makeConfig(),
    makeProbes({ canImportSdk: () => Promise.resolve(false) }),
  );
  assertEquals(result, "ok");
});

Deno.test("detectFirstRunState: canImportSdk false with no index → 'no-collections'", async () => {
  // SDK can't import AND index doesn't exist — genuinely no collections.
  const result = await detectFirstRunState(
    makeConfig(),
    makeProbes({
      canImportSdk: () => Promise.resolve(false),
      indexExists: () => Promise.resolve(false),
    }),
  );
  assertEquals(result, "no-collections");
});

Deno.test("detectFirstRunState: indexExists false → 'no-collections'", async () => {
  const result = await detectFirstRunState(
    makeConfig(),
    makeProbes({ indexExists: () => Promise.resolve(false) }),
  );
  assertEquals(result, "no-collections");
});

Deno.test("detectFirstRunState: listCollections returns [] → 'no-collections'", async () => {
  const result = await detectFirstRunState(
    makeConfig(),
    makeProbes({ listCollections: () => Promise.resolve([]) }),
  );
  assertEquals(result, "no-collections");
});

Deno.test("detectFirstRunState: single collection with doc_count: 0 → 'empty-index'", async () => {
  const result = await detectFirstRunState(
    makeConfig(),
    makeProbes({
      listCollections: () =>
        Promise.resolve([{ name: "default", doc_count: 0 }]),
    }),
  );
  assertEquals(result, "empty-index");
});

Deno.test("detectFirstRunState: mixed collections (some 0, some >0) → 'ok'", async () => {
  const result = await detectFirstRunState(
    makeConfig(),
    makeProbes({
      listCollections: () =>
        Promise.resolve([
          { name: "empty", doc_count: 0 },
          { name: "filled", doc_count: 42 },
          { name: "another-empty", doc_count: 0 },
        ]),
    }),
  );
  assertEquals(result, "ok");
});

Deno.test("detectFirstRunState: probe throwing in hasQmdBinary cascades to 'no-qmd'", async () => {
  const result = await detectFirstRunState(
    makeConfig(),
    makeProbes({
      hasQmdBinary: () => Promise.reject(new Error("boom")),
    }),
  );
  assertEquals(result, "no-qmd");
});

Deno.test("detectFirstRunState: probe timing out in listCollections cascades to 'no-collections'", async () => {
  // A probe that never resolves should hit the 100ms per-check timeout and be
  // treated as a failed check, cascading to 'no-collections' per SPEC §5.2.
  const result = await detectFirstRunState(
    makeConfig(),
    makeProbes({
      listCollections: () => new Promise(() => {}),
    }),
  );
  assertEquals(result, "no-collections");
});
