#!/usr/bin/env -S deno run --allow-net=localhost:8181 --allow-read=$HOME/.cache/qmd,$HOME/.config/qmd-swiftbar,$HOME/.cache/qmd-swiftbar --allow-write=$HOME/.cache/qmd-swiftbar,$HOME/.config/qmd-swiftbar --allow-run=/opt/homebrew/bin/qmd,/usr/local/bin/qmd,qmd,open,osascript,kill,bash --allow-env=HOME,PATH,EDITOR,QMD_SWIFTBAR_CACHE_DIR

// <swiftbar.title>qmd-swiftbar</swiftbar.title>
// <swiftbar.version>v1.0.0</swiftbar.version>
// <swiftbar.author>Gareth Evans</swiftbar.author>
// <swiftbar.author.github>ggfevans</swiftbar.author.github>
// <swiftbar.desc>Surface qmd operational state (collections, daemon, jobs) in the macOS menubar.</swiftbar.desc>
// <swiftbar.dependencies>qmd</swiftbar.dependencies>
// <swiftbar.abouturl>https://github.com/ggfevans/qmd-swiftbar</swiftbar.abouturl>

import { join } from "@std/path";
import { runAction } from "./lib/actions.ts";
import { loadConfig } from "./lib/config.ts";
import { detectFirstRunState } from "./lib/detect.ts";
import { renderFirstRunMenu, renderMenu } from "./lib/menu.ts";
import {
  cacheDir,
  ensureCacheTree,
  pruneFailuresOlderThan,
  pruneLogs,
  readSnapshot,
  resolveLogsDir,
  writeSnapshot,
} from "./lib/persistence.ts";
import { readCurrentStateWithSnapshot } from "./lib/state.ts";
import { computeTierWithReason } from "./lib/rollup.ts";
import { buildSnapshot, diffStates, emitNotifications } from "./lib/notify.ts";
import { logError } from "./lib/log.ts";
import type { ActionId } from "./lib/types.ts";

// Path to the error log file. Used both by the top-level fence's
// emergency menu and the menu degradation footer (rendered by
// lib/menu.ts when consecutiveReadFailures > 0).
const ERROR_LOG_PATH = `${cacheDir()}/error.log`;

async function main(): Promise<void> {
  // Action invocation path (SPEC §13.1). When SwiftBar re-invokes the
  // plugin with `--action <id> [--flag value ...]`, route to the
  // action runner and exit; the poll/render path below is skipped.
  if (Deno.args[0] === "--action") {
    const actionId = Deno.args[1] as ActionId;
    const argsMap: Record<string, string> = {};
    for (let i = 2; i < Deno.args.length; i += 2) {
      const flag = Deno.args[i];
      if (flag?.startsWith("--")) {
        argsMap[flag.slice(2)] = Deno.args[i + 1] ?? "";
      }
    }
    // Load config so the action runner can honour
    // `config.logs.directory` (PR #1 D5). On config-error, fall back
    // to the default `${cacheDir()}/logs` — the action runner can't
    // surface config errors to the user (no UI in this branch), so
    // we degrade silently. The poll path renders the config-error
    // header on the next tick.
    const { config: actionConfig } = await loadConfig();
    await runAction(
      actionId,
      argsMap,
      undefined,
      resolveLogsDir(actionConfig.logs.directory),
    );
    Deno.exit(0);
  }

  const { config, errors: configErrors } = await loadConfig();

  // Recheck sentinel (SPEC §13 / "Re-check now"): if the user just
  // clicked the first-run "Re-check now" entry, the action runner
  // wrote `${CACHE_DIR}/sentinels/recheck`. Consume it here so the
  // sentinel doesn't persist across polls. Every poll re-renders the
  // menu regardless, so the sentinel is mostly cosmetic — its removal
  // simply prevents it from accumulating on disk and provides a
  // visible "I saw your click" signal during local debugging.
  const recheckSentinel = join(cacheDir(), "sentinels", "recheck");
  try {
    await Deno.stat(recheckSentinel);
    await Deno.remove(recheckSentinel);
  } catch {
    // Missing file (the common case) or removal race; either way the
    // poll proceeds normally.
  }

  const firstRun = await detectFirstRunState(config);
  if (firstRun !== "ok") {
    console.log(renderFirstRunMenu(firstRun, config));
    Deno.exit(0);
  }
  // Persistence layer (step 6). Ensures cache dir tree exists and
  // loads the last snapshot for diff + dedupe.
  await ensureCacheTree();
  const prevSnapshot = await readSnapshot();

  // State reader (step 7) wrapped by the snapshot-aware degrader
  // (step 15 / SPEC §16.2). On read failure with a usable prev
  // snapshot, `state` is the synthesized last-good state; otherwise
  // it's the raw current poll. `degraded` and `consecutiveReadFailures`
  // flow into the renderer to surface the degradation header / footer.
  const { state, consecutiveReadFailures } = await readCurrentStateWithSnapshot(
    config,
    prevSnapshot,
  );

  // Rollup (step 8). Compute the tier from the (possibly synthesized)
  // state. Force red on three consecutive read failures per SPEC §16.2.
  const tier = computeTierWithReason(state, config);
  if (consecutiveReadFailures >= 3) {
    tier.tier = "red";
    tier.drivers.unshift("Status reads failed 3 polls in a row");
  }

  // Notifications (step 14). Diff against the previous snapshot,
  // assemble the new snapshot, fire opt-in notifications, then persist.
  // diff/emit/write happen before render so writeSnapshot runs even if
  // SwiftBar drops the stdout pipe mid-render.
  const events = diffStates(prevSnapshot, state, config);
  const newSnapshot = buildSnapshot(state, tier, prevSnapshot);
  // buildSnapshot carries `consecutiveReadFailures` from prev by
  // default; overwrite with the value computed by
  // readCurrentStateWithSnapshot so the counter reflects this poll.
  newSnapshot.consecutiveReadFailures = consecutiveReadFailures;
  await emitNotifications(events, newSnapshot, config);
  await writeSnapshot(newSnapshot);

  // Render the §10 healthy menu (step 9). Error-state degradation
  // (SPEC §10.4): when consecutiveReadFailures > 0, the renderer
  // prepends "⚠ Status read failed — using last poll (Nm ago)" and
  // appends "Show last error". Config validation errors (SPEC §7.5)
  // surface as "⚠ Config error — see logs" via errorContext.configErrors.
  const hasReadFailure = consecutiveReadFailures > 0;
  const hasConfigError = configErrors.length > 0;
  const errorContext = (hasReadFailure || hasConfigError)
    ? {
      lastGoodAt: prevSnapshot ? new Date(prevSnapshot.pollTimestamp) : null,
      consecutiveFailures: consecutiveReadFailures,
      configErrors,
    }
    : undefined;
  console.log(renderMenu(state, tier, config, errorContext));

  // Cleanup pass (SPEC §15.3): trim recent-failures past the amber
  // window and rotate log files down to `retain_per_action`. Both
  // are best-effort filesystem ops; persistence.ts swallows errors
  // internally so they can't mask the rendered menu output.
  await pruneFailuresOlderThan(config.rollup.error_window.amber_hours);
  await pruneLogs(
    config.logs.retain_per_action,
    resolveLogsDir(config.logs.directory),
  );

  Deno.exit(0);
}

// Top-level fence per SPEC §16.3. Any uncaught throw inside `main()`
// lands here; we log it and emit a minimal emergency menu so SwiftBar
// renders something sensible instead of a blank icon. Exit 0 keeps
// SwiftBar from flagging the plugin as crashed.
try {
  await main();
} catch (e) {
  const err = e instanceof Error ? e : new Error(String(e));
  await logError("main", "unhandled", err);
  console.log("⚠");
  console.log("---");
  console.log(`Unhandled error: ${err.message} | shell=`);
  console.log(
    `Show error log | bash="open" param1="-t" param2="${ERROR_LOG_PATH}" terminal=false`,
  );
  Deno.exit(0);
}
