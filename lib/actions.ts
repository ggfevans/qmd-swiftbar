import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { ActionId, JobInfo } from "./types.ts";
import { qmdExecEnv } from "./exec-env.ts";
import {
  atomicCreateJobPidFile as productionAtomicCreateJobPidFile,
  cacheDir,
  deleteJobPidFile as productionDeleteJobPidFile,
  readJobPidFile as productionReadJobPidFile,
  writeJobPidFile as productionWriteJobPidFile,
} from "./persistence.ts";
import { logError, logInfo } from "./log.ts";

// ─── Validation ────────────────────────────────────────────────

/**
 * Allowed shape for collection names that are interpolated into shell
 * commands. Mirrors `SAFE_COLLECTION_NAME` in lib/menu.ts. Defined
 * here too so the runner can defend itself without importing the
 * rendering module.
 */
const SAFE_COLLECTION_NAME = /^[A-Za-z0-9_.-]+$/;

/** Per-collection actions require a `collection` arg. */
const PER_COLLECTION_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>([
  "update-collection",
  "embed-collection",
  "force-reembed-collection",
  "show-context",
]);

// ─── DI seam ───────────────────────────────────────────────────

/**
 * Injection seam for `runAction`. Mirrors the DI patterns used in
 * `lib/state.ts` / `lib/detect.ts`: every external effect is a
 * dependency so tests can mock without touching the filesystem,
 * spawning processes, or invoking osascript.
 */
export type ActionDeps = {
  readJobPidFile: (
    action: ActionId,
    collection?: string,
  ) => Promise<JobInfo | null>;
  writeJobPidFile: (action: ActionId, info: JobInfo) => Promise<void>;
  /**
   * Atomically acquire the job lock using O_EXCL semantics. Returns true
   * if the lock was acquired (file created), false if another process
   * holds it. Handles stale locks by cleaning them up and retrying.
   * See SPEC §13.3, D8.
   */
  tryAcquireLock: (action: ActionId, collection?: string) => Promise<boolean>;
  /**
   * Delete the PID file for a job. No-op if the file doesn't exist.
   * Used to release the lock on spawn failure.
   */
  deleteJobPidFile: (action: ActionId, collection?: string) => Promise<void>;
  /** Spawn the command detached, returning the background PID. */
  spawnDetached: (commandString: string, logPath: string) => Promise<number>;
  /** True if the PID is still alive. SIGCONT probe in production. */
  isProcessAlive: (pid: number) => boolean;
  /** Touch a sentinel file under `${CACHE_DIR}/sentinels/`. */
  touchSentinel: (name: string) => Promise<void>;
  /** Capture the output of `qmd context list -c <name>`. */
  runQmdContextList: (collection: string) => Promise<string>;
  /** Display the qmd-context output via osascript. Blocks until OK. */
  showContextDialog: (collection: string, output: string) => Promise<void>;
  /**
   * Show a Cancel/<proceedLabel> confirmation dialog (SPEC §11.2).
   * Returns true if the user clicked the proceed button, false on
   * Cancel, timeout, or any error. Production impl uses osascript.
   */
  confirmDialog: (message: string, proceedLabel: string) => Promise<boolean>;
  /** Exit the runner cleanly. Tests record the call instead of exiting. */
  exit: (code: number) => void;
};

// ─── Production deps ───────────────────────────────────────────

/**
 * Spawn `commandString` detached via the SPEC §13.2 wrapper. stdout
 * yields the background PID (the trailing `echo $!`). Stderr is
 * discarded — anything written to stderr inside the wrapped command
 * is captured in the log file via `2>&1`.
 */
async function productionSpawnDetached(
  commandString: string,
  logPath: string,
): Promise<number> {
  // Use the resolved logPath's parent directly — honours
  // `config.logs.directory` when the caller threaded it through
  // `buildLogPath`. See PR #1 D5.
  await ensureDir(join(logPath, ".."));
  const shell =
    `( ${commandString}; echo "EXIT_CODE=$?" >> "${logPath}" ) >> "${logPath}" 2>&1 &\necho $!`;
  const proc = new Deno.Command("bash", {
    args: ["-c", shell],
    env: qmdExecEnv(),
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await proc.output();
  const pid = parseInt(new TextDecoder().decode(stdout).trim(), 10);
  return pid;
}

/**
 * SIGCONT probe per SPEC §13.5. SIGCONT is harmless to a running
 * process (continues it if stopped, no-op otherwise). `Deno.kill`
 * throws `NotFound` / `PermissionDenied` for dead/foreign PIDs.
 *
 * Exported so the state reader (lib/state.ts) can reuse the same
 * production probe when checking completion of in-flight jobs.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically acquire the job lock using O_EXCL semantics (SPEC §13.3, D8).
 *
 * 1. Try `Deno.open(path, { createNew: true })` — if it succeeds, the
 *    lock is ours.
 * 2. If AlreadyExists, read the file and check PID liveness. A PID of
 *    -1 means another runner is currently spawning; treat as locked.
 * 3. If the process is alive, the lock is held — return false.
 * 4. If the process is dead (stale lock), delete the file and retry
 *    the atomic create. If the retry also fails, someone else grabbed
 *    it between our delete and create — return false.
 */
async function productionTryAcquireLock(
  action: ActionId,
  collection?: string,
): Promise<boolean> {
  if (await productionAtomicCreateJobPidFile(action, collection)) {
    return true;
  }

  // File exists — check if the process is alive.
  const info = await productionReadJobPidFile(action, collection);
  if (info === null) {
    // File is empty or malformed (crash between create and write), or
    // disappeared between create and read. Remove the stale file and
    // retry once — bounded, no recursion.
    await productionDeleteJobPidFile(action, collection);
    return productionAtomicCreateJobPidFile(action, collection);
  }
  // PID -1 means another runner is mid-spawn (placeholder).
  if (info.pid === -1 || isProcessAlive(info.pid)) {
    return false;
  }

  // Stale lock — remove and retry.
  await productionDeleteJobPidFile(action, collection);
  return productionAtomicCreateJobPidFile(action, collection);
}

/**
 * Write/touch a sentinel file under `${CACHE_DIR}/sentinels/`. The
 * value is the current ISO timestamp so consumers can see how stale
 * the request is; the file's existence is the trigger.
 */
async function productionTouchSentinel(name: string): Promise<void> {
  const dir = join(cacheDir(), "sentinels");
  await ensureDir(dir);
  await Deno.writeTextFile(join(dir, name), new Date().toISOString());
}

/**
 * Run `qmd context list -c <name>` synchronously and return stdout.
 * Errors are logged and an empty string is returned so the dialog
 * still opens with a "no context" message rather than the runner
 * crashing.
 */
async function productionRunQmdContextList(
  collection: string,
): Promise<string> {
  try {
    const proc = new Deno.Command("qmd", {
      args: ["context", "list", "-c", collection],
      env: qmdExecEnv(),
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout, stderr, code } = await proc.output();
    if (code !== 0) {
      const errText = new TextDecoder().decode(stderr).trim();
      await logError(
        "actions",
        `runQmdContextList: qmd exited ${code} for "${collection}": ${errText}`,
      );
    }
    return new TextDecoder().decode(stdout);
  } catch (err) {
    await logError(
      "actions",
      `runQmdContextList: failed to spawn qmd for "${collection}"`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return "";
  }
}

/** AppleScript-escape a string for embedding inside double quotes. */
export function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Show the qmd-context output via `osascript -e 'display dialog ...'`.
 * Long outputs are truncated to ~10 KB to keep the dialog tractable
 * (osascript has a hard limit on argument length).
 */
async function productionShowContextDialog(
  collection: string,
  output: string,
): Promise<void> {
  const MAX = 10_000;
  const body = output.length > MAX
    ? output.slice(0, MAX) + "\n…(truncated)"
    : output;
  const safeBody = escapeForAppleScript(body || "(no context available)");
  const safeTitle = escapeForAppleScript(`qmd context — ${collection}`);
  const script =
    `display dialog "${safeBody}" with title "${safeTitle}" buttons {"OK"} default button "OK"`;

  try {
    const proc = new Deno.Command("osascript", {
      args: ["-e", script],
      stdout: "null",
      stderr: "null",
    });
    await proc.output();
  } catch (err) {
    await logError(
      "actions",
      `showContextDialog: osascript failed for "${collection}"`,
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

/**
 * Show a Cancel/<proceedLabel> dialog via osascript (SPEC §11.2).
 *
 * The dialog defaults to Cancel, so pressing Enter or letting the
 * 60-second timeout elapse both behave as cancel. The function returns
 * true ONLY when stdout contains `button returned:<proceedLabel>` —
 * any other outcome (Cancel button, timeout exit, osascript spawn
 * error) collapses to false so destructive actions stay safe by
 * default.
 */
/**
 * Build the AppleScript source for the confirmation dialog. Extracted
 * from `productionConfirmDialog` so tests can assert on the exact
 * script string without invoking `osascript`. See PR #1 A7.
 *
 * `giving up after 60` makes the dialog auto-dismiss after 60 seconds
 * if the user walks away — AppleScript surfaces this in stdout as
 * `gave up:true`. SwiftBar's plugin process stays alive for the
 * duration, so without the timeout a destructive-action dialog could
 * hang forever and pile up zombie osascript processes. See SPEC §11.2.
 */
export function buildConfirmDialogScript(
  message: string,
  proceedLabel: string,
): string {
  const safeMessage = escapeForAppleScript(message);
  const safeProceed = escapeForAppleScript(proceedLabel);
  return `display dialog "${safeMessage}" with title "qmd-swiftbar" ` +
    `buttons {"Cancel", "${safeProceed}"} default button "Cancel" ` +
    `with icon caution giving up after 60`;
}

/**
 * Parse `osascript`'s stdout for the confirmation dialog. Returns
 * true ONLY when the user clicked the proceed button. Cancel,
 * 60-second timeout (`gave up:true`), and any other shape collapse to
 * false so destructive actions stay safe by default. See PR #1 A7.
 */
export function parseConfirmDialogOutput(
  stdoutText: string,
  proceedLabel: string,
): boolean {
  // Timeout path: AppleScript emits `gave up:true` instead of the
  // button-returned line. Treat as Cancel.
  if (stdoutText.includes("gave up:true")) return false;
  return stdoutText.includes(`button returned:${proceedLabel}`);
}

async function productionConfirmDialog(
  message: string,
  proceedLabel: string,
): Promise<boolean> {
  const script = buildConfirmDialogScript(message, proceedLabel);
  try {
    const proc = new Deno.Command("osascript", {
      args: ["-e", script],
      stdout: "piped",
      stderr: "null",
    });
    const { stdout, code } = await proc.output();
    if (code !== 0) return false;
    const text = new TextDecoder().decode(stdout);
    return parseConfirmDialogOutput(text, proceedLabel);
  } catch (err) {
    await logError(
      "actions",
      `confirmDialog: osascript failed for "${proceedLabel}"`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return false;
  }
}

const PRODUCTION_DEPS: ActionDeps = {
  readJobPidFile: productionReadJobPidFile,
  writeJobPidFile: productionWriteJobPidFile,
  tryAcquireLock: productionTryAcquireLock,
  deleteJobPidFile: productionDeleteJobPidFile,
  spawnDetached: productionSpawnDetached,
  isProcessAlive,
  touchSentinel: productionTouchSentinel,
  runQmdContextList: productionRunQmdContextList,
  showContextDialog: productionShowContextDialog,
  confirmDialog: productionConfirmDialog,
  exit: (code) => Deno.exit(code),
};

// ─── Command construction ──────────────────────────────────────

type CommandSpec = {
  /** argv-shaped command, recorded into the PID file's `command` field. */
  argv: string[];
  /** Flattened shell string passed to `bash -c`. */
  shell: string;
};

/**
 * Build the SPEC §5.2 command for an action. Returns `null` for
 * actions that don't spawn (recheck, show-context) or when the args
 * fail validation.
 *
 * The shell string is constructed only from SPEC-fixed argv plus an
 * already-validated collection name; no other user input is
 * interpolated. The argv form is what we persist into the PID file.
 */
function buildCommand(
  id: ActionId,
  collection: string | undefined,
): CommandSpec | null {
  switch (id) {
    case "update-all":
      return { argv: ["qmd", "update"], shell: "qmd update" };
    case "embed-all":
      return { argv: ["qmd", "embed"], shell: "qmd embed" };
    case "update-collection": {
      if (!collection) return null;
      return {
        argv: ["qmd", "update", "&&", "qmd", "embed", "-c", collection],
        shell: `qmd update && qmd embed -c ${collection}`,
      };
    }
    case "embed-collection": {
      if (!collection) return null;
      return {
        argv: ["qmd", "embed", "-c", collection],
        shell: `qmd embed -c ${collection}`,
      };
    }
    case "force-reembed-collection": {
      if (!collection) return null;
      return {
        argv: ["qmd", "embed", "-c", collection, "-f"],
        shell: `qmd embed -c ${collection} -f`,
      };
    }
    case "restart-daemon":
      return {
        argv: ["qmd", "mcp", "stop", "&&", "qmd", "mcp", "--http", "--daemon"],
        shell: "qmd mcp stop && qmd mcp --http --daemon",
      };
    case "stop-daemon":
      return { argv: ["qmd", "mcp", "stop"], shell: "qmd mcp stop" };
    case "start-daemon":
      return {
        argv: ["qmd", "mcp", "--http", "--daemon"],
        shell: "qmd mcp --http --daemon",
      };
    case "cleanup":
      return { argv: ["qmd", "cleanup"], shell: "qmd cleanup" };
    case "recheck":
    case "show-context":
      return null;
  }
}

/**
 * Generate the log filename for this run. SPEC §15.3 timestamp form.
 *
 * `logsDir` honours `config.logs.directory` (PR #1 D5). Defaults to
 * `${cacheDir()}/logs` when omitted so existing callers that haven't
 * been wired through the config don't regress.
 *
 * The timestamp strips dashes as well as `:` and `.` — without that,
 * the resulting filename (e.g. `update-all-2026-05-17T100000000Z.log`)
 * has internal dashes inside the timestamp segment, and
 * `parseLogFileName`'s `lastIndexOf("-")` lands inside the date instead
 * of on the action/timestamp delimiter. See PR #1 A3.
 */
function buildLogPath(
  id: ActionId,
  collection: string | undefined,
  now: Date,
  logsDir?: string,
): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  const key = collection ? `${id}:${collection}` : id;
  const dir = logsDir && logsDir.length > 0
    ? logsDir
    : join(cacheDir(), "logs");
  return join(dir, `${key}-${stamp}.log`);
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Execute the action identified by `id`. Per-collection actions
 * require `args.collection`. The runner:
 *
 *   1. Validates args (collection name shape, presence).
 *   2. Acquires the per-action (or per-action:collection) lock.
 *   3. Spawns the qmd command detached, writes a PID file.
 *
 * Recheck and show-context bypass spawn entirely:
 *   - recheck: touches `${CACHE_DIR}/sentinels/recheck` and returns.
 *   - show-context: runs `qmd context list -c <name>` synchronously
 *     and shows the output in an osascript dialog.
 *
 * Destructive actions (`force-reembed-collection`, `cleanup`) gate
 * on `confirmDialog` per SPEC §11.2 — the runner returns silently if
 * the user cancels or the dialog times out. The osascript invocation
 * is injected via the dep so tests can simulate either branch.
 *
 * Completion detection (PID liveness, log-tail EXIT_CODE parsing,
 * failure notifications) lives in the poll cycle, not the runner.
 *
 * Never throws. On invalid args or spawn failure, logs and returns.
 */
export async function runAction(
  id: ActionId,
  args: Record<string, string>,
  deps?: Partial<ActionDeps>,
  // `logsDir` honours `config.logs.directory` (PR #1 D5). Falls back
  // to `${cacheDir()}/logs` when omitted/empty. Pass-through to
  // buildLogPath so action log files land in the configured tree.
  logsDir?: string,
): Promise<void> {
  const d: ActionDeps = {
    readJobPidFile: deps?.readJobPidFile ?? PRODUCTION_DEPS.readJobPidFile,
    writeJobPidFile: deps?.writeJobPidFile ?? PRODUCTION_DEPS.writeJobPidFile,
    tryAcquireLock: deps?.tryAcquireLock ?? PRODUCTION_DEPS.tryAcquireLock,
    deleteJobPidFile: deps?.deleteJobPidFile ??
      PRODUCTION_DEPS.deleteJobPidFile,
    spawnDetached: deps?.spawnDetached ?? PRODUCTION_DEPS.spawnDetached,
    isProcessAlive: deps?.isProcessAlive ?? PRODUCTION_DEPS.isProcessAlive,
    touchSentinel: deps?.touchSentinel ?? PRODUCTION_DEPS.touchSentinel,
    runQmdContextList: deps?.runQmdContextList ??
      PRODUCTION_DEPS.runQmdContextList,
    showContextDialog: deps?.showContextDialog ??
      PRODUCTION_DEPS.showContextDialog,
    confirmDialog: deps?.confirmDialog ?? PRODUCTION_DEPS.confirmDialog,
    exit: deps?.exit ?? PRODUCTION_DEPS.exit,
  };

  const collection = args.collection;

  // ── Recheck: write a sentinel and return. ─────────────────
  if (id === "recheck") {
    try {
      await d.touchSentinel("recheck");
    } catch (err) {
      await logError(
        "actions",
        "recheck: failed to touch sentinel",
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    return;
  }

  // ── Show-context: synchronous; no PID tracking. ───────────
  if (id === "show-context") {
    if (!collection || !SAFE_COLLECTION_NAME.test(collection)) {
      await logError(
        "actions",
        `show-context: missing or invalid collection (got "${
          collection ?? ""
        }")`,
      );
      return;
    }
    try {
      const output = await d.runQmdContextList(collection);
      await d.showContextDialog(collection, output);
    } catch (err) {
      await logError(
        "actions",
        `show-context: failed for "${collection}"`,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    return;
  }

  // ── Per-collection arg validation. ────────────────────────
  if (PER_COLLECTION_ACTIONS.has(id)) {
    if (!collection) {
      await logError(
        "actions",
        `${id}: missing required "collection" arg`,
      );
      return;
    }
    if (!SAFE_COLLECTION_NAME.test(collection)) {
      await logError(
        "actions",
        `${id}: collection "${collection}" contains unsafe characters; refusing to spawn`,
      );
      return;
    }
  }

  // ── Confirmation dialogs for destructive actions (SPEC §11.2). ─
  //
  // Force re-embed wipes & recomputes every chunk for a collection;
  // cleanup deletes orphaned cache data. Both must surface a confirm
  // before we touch the qmd CLI. Args are already validated above, so
  // the collection name interpolated into the message has passed
  // SAFE_COLLECTION_NAME — no AppleScript-injection risk beyond the
  // string escaping inside productionConfirmDialog.
  if (id === "force-reembed-collection") {
    const ok = await d.confirmDialog(
      `Force re-embed all chunks in ${collection}? This will take several minutes.`,
      "Re-embed",
    );
    if (!ok) return;
  }
  if (id === "cleanup") {
    const ok = await d.confirmDialog(
      "Clean up orphaned data from the qmd cache? This is generally safe but cannot be undone.",
      "Clean up",
    );
    if (!ok) return;
  }

  // ── Build the command spec. ───────────────────────────────
  const spec = buildCommand(id, collection);
  if (!spec) {
    await logError(
      "actions",
      `${id}: unable to build command (collection=${collection ?? "—"})`,
    );
    return;
  }

  // ── Locking (SPEC §13.3, D8 atomic O_EXCL). ──────────────
  let locked: boolean;
  try {
    locked = await d.tryAcquireLock(id, collection);
  } catch (err) {
    await logInfo(
      "actions",
      `${id}${
        collection ? `:${collection}` : ""
      }: lock acquisition failed; skipping spawn: ${err}`,
    );
    return;
  }
  if (!locked) {
    await logInfo(
      "actions",
      `${id}${
        collection ? `:${collection}` : ""
      }: already running; skipping spawn`,
    );
    d.exit(0);
    return;
  }

  // ── Spawn detached and persist the PID. ───────────────────
  const startedAt = new Date();
  const logPath = buildLogPath(id, collection, startedAt, logsDir);

  // Write a placeholder PID file so the lock is visible to
  // concurrent runners. The pid=-1 sentinel tells tryAcquireLock
  // that a spawn is in progress. Overwritten with the real PID
  // after spawn succeeds.
  try {
    await d.writeJobPidFile(id, {
      action: id,
      collection,
      pid: -1,
      startedAt,
      command: spec.argv,
      logPath,
    });
  } catch (err) {
    // Placeholder write failed — release the lock so the next poll can
    // retry. Without this, the empty/malformed PID file would block all
    // future runs for this (action, collection) pair.
    await d.deleteJobPidFile(id, collection).catch(() => {});
    await logError(
      "actions",
      `${id}: writeJobPidFile (placeholder) failed`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return;
  }

  let pid: number;
  try {
    pid = await d.spawnDetached(spec.shell, logPath);
  } catch (err) {
    // Spawn failed — release the lock so the next poll can retry.
    await d.deleteJobPidFile(id, collection).catch(() => {});
    await logError(
      "actions",
      `${id}: spawn failed`,
      err instanceof Error ? err : new Error(String(err)),
    );
    return;
  }

  if (!Number.isFinite(pid) || pid <= 0) {
    // Invalid PID — release the lock.
    await d.deleteJobPidFile(id, collection).catch(() => {});
    await logError(
      "actions",
      `${id}: spawn returned invalid pid (${pid})`,
    );
    return;
  }

  try {
    await d.writeJobPidFile(id, {
      action: id,
      collection,
      pid,
      startedAt,
      command: spec.argv,
      logPath,
    });
  } catch (err) {
    await logError(
      "actions",
      `${id}: writeJobPidFile failed`,
      err instanceof Error ? err : new Error(String(err)),
    );
    // Remove the placeholder PID file so the lock is released.
    try {
      await d.deleteJobPidFile(id, collection);
    } catch (removeErr) {
      await logError(
        "actions",
        `${id}: failed to remove PID file after writeJobPidFile failure`,
        removeErr instanceof Error ? removeErr : new Error(String(removeErr)),
      );
    }
  }
}
