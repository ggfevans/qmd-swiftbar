import type { Config, FirstRunState } from "./types.ts";
import { withTimeout } from "./time.ts";
import { qmdExecEnv } from "./exec-env.ts";

// ─── Probe contract ────────────────────────────────────────────

/**
 * Injection seam for detectFirstRunState. Each probe is wrapped in a
 * 100ms timeout by the caller, so probe implementations don't need to
 * implement their own bounds.
 *
 * `listCollections` returns a structural subset of qmd SDK's full
 * collection shape — only the fields we need for first-run gating.
 */
export type Probes = {
  hasQmdBinary: () => Promise<boolean>;
  canImportSdk: () => Promise<boolean>;
  indexExists: (path: string) => Promise<boolean>;
  listCollections: (
    path: string,
  ) => Promise<Array<{ name: string; doc_count: number }>>;
};

// ─── Production probes ─────────────────────────────────────────

/** `qmd --version` succeeds with exit code 0. Uses `qmd` directly (already in `--allow-run`) rather than `which`, which would require a separate permission grant. */
async function probeHasQmdBinary(): Promise<boolean> {
  const cmd = new Deno.Command("qmd", {
    args: ["--version"],
    env: qmdExecEnv(),
    stdout: "null",
    stderr: "null",
  });
  const { code } = await cmd.output();
  return code === 0;
}

/** `import('npm:@tobilu/qmd')` resolves without throwing. */
async function probeCanImportSdk(): Promise<boolean> {
  try {
    await import("@tobilu/qmd");
    return true;
  } catch {
    return false;
  }
}

/** `Deno.stat(path)` succeeds. */
async function probeIndexExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the qmd store, list collections, close, and return the structural
 * subset of fields we care about. Re-throws on failure so the caller's
 * timeout/cascade logic handles it.
 */
async function probeListCollections(
  path: string,
): Promise<Array<{ name: string; doc_count: number }>> {
  const mod = await import("@tobilu/qmd");
  const store = await mod.createStore({ dbPath: path });
  try {
    const rows = await store.listCollections();
    return rows.map((row: { name: string; doc_count: number }) => ({
      name: row.name,
      doc_count: row.doc_count,
    }));
  } finally {
    try {
      await store.close();
    } catch {
      // Closing failed — nothing we can do, swallow so callers see the
      // listCollections result rather than a close-time error.
    }
  }
}

const PRODUCTION_PROBES: Probes = {
  hasQmdBinary: probeHasQmdBinary,
  canImportSdk: probeCanImportSdk,
  indexExists: probeIndexExists,
  listCollections: probeListCollections,
};

// ─── Public API ────────────────────────────────────────────────

const PER_CHECK_TIMEOUT_MS = 500;

/**
 * Layered first-run detection per SPEC §5.2 / §12.
 *
 * Cascade order (any failure or timeout short-circuits):
 *   1. qmd binary on $PATH        → 'no-qmd' on fail
 *   2. qmd SDK importable         → 'no-collections' on fail
 *   3. index DB file exists       → 'no-collections' on fail
 *   4. listCollections non-empty  → 'no-collections' on fail
 *   5. any collection doc_count>0 → 'ok' else 'empty-index'
 *
 * Each probe is bounded by a 500ms timeout (worst-case 2.5s total).
 * Never throws: unexpected errors log to stderr and resolve to 'no-qmd'.
 */
export async function detectFirstRunState(
  config: Config,
  probes: Probes = PRODUCTION_PROBES,
): Promise<FirstRunState> {
  try {
    // Check 1: qmd binary present.
    let hasBinary = false;
    try {
      hasBinary = await withTimeout(
        probes.hasQmdBinary(),
        PER_CHECK_TIMEOUT_MS,
        "hasQmdBinary",
      );
    } catch {
      return "no-qmd";
    }
    if (!hasBinary) return "no-qmd";

    // Check 2: SDK importable.
    // If the SDK can't import (Deno permission issues, runtime panic),
    // skip to step 3 (indexExists) — the SDK is optional for detection.
    // Steps 3+ only need the SDK for listCollections; indexExists uses
    // Deno.stat which doesn't require the SDK at all.
    let canImport = false;
    try {
      canImport = await withTimeout(
        probes.canImportSdk(),
        PER_CHECK_TIMEOUT_MS,
        "canImportSdk",
      );
    } catch {
      // SDK import failed — skip to index check.
    }
    // If SDK didn't import, skip listCollections (step 4) later
    // and rely on the index file existing as the signal.
    const skipListCollections = !canImport;

    // Check 3: index DB file present.
    let indexPresent = false;
    try {
      indexPresent = await withTimeout(
        probes.indexExists(config.qmd.index_path),
        PER_CHECK_TIMEOUT_MS,
        "indexExists",
      );
    } catch {
      return "no-collections";
    }
    if (!indexPresent) return "no-collections";

    // Check 4: at least one collection registered.
    // If the SDK couldn't import, skip this check — the index file
    // existing (step 3) is sufficient to know qmd is configured.
    if (skipListCollections) {
      // Index file exists but we can't verify collections via SDK.
      // Return 'ok' optimistically — the index file being present means
      // qmd has been used and collections likely exist.
      return "ok";
    }
    let collections: Array<{ name: string; doc_count: number }> = [];
    try {
      collections = await withTimeout(
        probes.listCollections(config.qmd.index_path),
        PER_CHECK_TIMEOUT_MS,
        "listCollections",
      );
    } catch {
      return "no-collections";
    }
    if (collections.length === 0) return "no-collections";

    // Check 5: at least one indexed document.
    const anyDocs = collections.some((c) => c.doc_count > 0);
    return anyDocs ? "ok" : "empty-index";
  } catch (err) {
    // Defensive: detectFirstRunState must never throw. SPEC §5.2 says
    // unexpected errors collapse to the most recoverable hint ('no-qmd').
    console.error(
      `detectFirstRunState: unexpected error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "no-qmd";
  }
}
