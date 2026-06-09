import type {
  ActionId,
  CollectionState,
  Config,
  CurrentState,
  FirstRunState,
  JobInfo,
  Tier,
  TierReason,
} from "./types.ts";
import { compactDuration, relativeTime } from "./time.ts";
import { actionLabel, computeTier } from "./rollup.ts";
import { CONFIG_PATH } from "./config.ts";
import { cacheDir } from "./persistence.ts";
import { logError } from "./log.ts";
import { fromFileUrl } from "@std/path";

// ─── Icon glyphs (SPEC §9.3) ──────────────────────────────────
//
// Pre-computed base64 of the monochrome 14×14 SVG templates. Embedding
// the encoded bytes as constants avoids re-encoding on every poll.
//
// Source SVGs:
//
//   Filled:
//   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14">
//     <circle cx="6.2" cy="6.2" r="4.2" fill="currentColor"/>
//     <circle cx="6.2" cy="6.2" r="1.6" fill="white"/>
//     <line x1="8.6" y1="8.6" x2="11.2" y2="11.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
//   </svg>
//
//   Hollow:
//   <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14">
//     <circle cx="6.2" cy="6.2" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/>
//     <line x1="8.6" y1="8.6" x2="11.2" y2="11.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
//   </svg>

const FILLED_GLYPH_B64 =
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNCAxNCIgd2lkdGg9IjE0IiBoZWlnaHQ9IjE0Ij48Y2lyY2xlIGN4PSI2LjIiIGN5PSI2LjIiIHI9IjQuMiIgZmlsbD0iY3VycmVudENvbG9yIi8+PGNpcmNsZSBjeD0iNi4yIiBjeT0iNi4yIiByPSIxLjYiIGZpbGw9IndoaXRlIi8+PGxpbmUgeDE9IjguNiIgeTE9IjguNiIgeDI9IjExLjIiIHkyPSIxMS4yIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==";

const HOLLOW_GLYPH_B64 =
  "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNCAxNCIgd2lkdGg9IjE0IiBoZWlnaHQ9IjE0Ij48Y2lyY2xlIGN4PSI2LjIiIGN5PSI2LjIiIHI9IjQuMiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMS40Ii8+PGxpbmUgeDE9IjguNiIgeTE9IjguNiIgeDI9IjExLjIiIHkyPSIxMS4yIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPg==";

// ─── Plugin path helper ────────────────────────────────────────

/**
 * Absolute filesystem path of the running script. Used inside menu
 * directives like `bash="<plugin-path>" param1="--action" param2="…"`
 * so SwiftBar can re-invoke the plugin with action arguments.
 *
 * Deno.mainModule is a `file://` URL; `fromFileUrl` decodes percent
 * escapes (e.g. `%20` → space) so paths containing spaces — like the
 * default SwiftBar install location `~/Library/Application Support/
 * SwiftBar/Plugins` — survive the round-trip into a SwiftBar `bash=`
 * directive without corruption.
 */
export function getPluginPath(): string {
  return fromFileUrl(Deno.mainModule);
}

// ─── First-run menu rendering (SPEC §12) ──────────────────────

/**
 * Render one of the three first-run menus. The 'ok' state has its own
 * full healthy menu (SPEC §10) and is not handled here.
 *
 * The output is a single string with lines joined by '\n', terminated
 * by a trailing newline so console.log doesn't double-space.
 */
export function renderFirstRunMenu(
  firstRun: Exclude<FirstRunState, "ok">,
  config: Config,
): string {
  const pluginPath = getPluginPath();
  switch (firstRun) {
    case "no-qmd":
      return renderNoQmd(pluginPath);
    case "no-collections":
      return renderNoCollections(pluginPath);
    case "empty-index":
      return renderEmptyIndex(pluginPath, config);
  }
}

// ─── Per-state renderers (internal) ───────────────────────────

function renderNoQmd(pluginPath: string): string {
  const lines = [
    `| image=${HOLLOW_GLYPH_B64} templateImage=true tooltip="qmd not detected"`,
    "---",
    "qmd not detected | size=10 color=#8a8a8e shell=",
    `   Install qmd from github.com/tobi/qmd | bash="open" param1="https://github.com/tobi/qmd#installation" terminal=false`,
    `   Re-check now | bash="${pluginPath}" param1="--action" param2="recheck" terminal=false refresh=true`,
    "---",
    `   Preferences… | bash="open" param1="-t" param2="${CONFIG_PATH}" terminal=false`,
    `   About qmd-swiftbar | bash="open" param1="https://github.com/ggfevans/qmd-swiftbar" terminal=false`,
  ];
  return lines.join("\n") + "\n";
}

function renderNoCollections(pluginPath: string): string {
  const lines = [
    `| image=${HOLLOW_GLYPH_B64} templateImage=true tooltip="No collections configured"`,
    "---",
    "No collections configured | size=10 color=#8a8a8e shell=",
    "   qmd is installed but you have no collections. | size=11 color=#6e6e72 shell=",
    `   Open the qmd README… | bash="open" param1="https://github.com/tobi/qmd#collection-management" terminal=false`,
    "   Run 'qmd collection add' in a terminal to start. | size=11 color=#6e6e72 shell=",
    `   Re-check now | bash="${pluginPath}" param1="--action" param2="recheck" terminal=false refresh=true`,
    "---",
    `   Preferences… | bash="open" param1="-t" param2="${CONFIG_PATH}" terminal=false`,
    `   About qmd-swiftbar | bash="open" param1="https://github.com/ggfevans/qmd-swiftbar" terminal=false`,
  ];
  return lines.join("\n") + "\n";
}

function renderEmptyIndex(pluginPath: string, _config: Config): string {
  // The §12.3 mockup ends with "…(normal menu structure follows)…" — the
  // §10 healthy menu. For step 4 we render just the Preferences / About
  // footer; the full §10 structure lands in step 9 once the renderers
  // for collections, daemon, jobs, etc. are in place.
  // (deferred to step 9: expand the empty-index trailer into the §10
  // healthy menu structure)
  const lines = [
    `| image=${FILLED_GLYPH_B64} color=#ec9b2c templateImage=true tooltip="Index has no documents"`,
    "---",
    "Index has no documents | size=10 color=#412402 shell=",
    "   Collections are registered but nothing's been indexed yet.",
    "---",
    `↻ Run update | bash="${pluginPath}" param1="--action" param2="update-all" terminal=false refresh=true`,
    "---",
    `   Preferences… | bash="open" param1="-t" param2="${CONFIG_PATH}" terminal=false`,
    `   About qmd-swiftbar | bash="open" param1="https://github.com/ggfevans/qmd-swiftbar" terminal=false`,
  ];
  return lines.join("\n") + "\n";
}

// ─── Healthy menu rendering (SPEC §10) ────────────────────────

// Tier → dot/text colours (SPEC §10.2). The greys are used both for
// the hollow-Q glyph (no `color=` override) and for muted section
// headers / info rows; the explicit hex constant exists so callers
// don't reinvent it.
const TIER_HEX: Record<Tier, string> = {
  green: "#2fa84f",
  amber: "#ec9b2c",
  red: "#d8453f",
  grey: "#8a8a8e",
};

const MUTED_HEX = "#8a8a8e";

// Daemon row uses SwiftBar `length=44` + `trim=false` to right-align
// the uptime against the left-aligned status text. Manual padding
// inside the same string is what produces the visible alignment when
// SwiftBar honours `trim=false`.
const DAEMON_ROW_LENGTH = 44;

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

/**
 * Per-collection tier rollup. Reuses `computeTier` on a state slice
 * that contains only this collection; everything else is set to a
 * "healthy" baseline so the slice's tier reflects this collection's
 * own coverage / freshness / reachability — not the daemon, in-flight
 * jobs, or failures (those are accounted for at the global tier).
 *
 * The slice's `polledAt` mirrors the parent state's so freshness
 * thresholds line up with the rest of the rendering.
 */
function collectionTier(
  c: CollectionState,
  config: Config,
  polledAt: Date,
): Tier {
  const slice: CurrentState = {
    collections: [c],
    status: {
      totalDocs: c.docCount,
      totalCollections: 1,
      dbSizeBytes: 0,
      modelCacheBytes: 0,
    },
    daemon: {
      status: "running",
      endpoint: "",
      uptimeSeconds: 0,
    },
    inFlightJobs: [],
    recentFailures: [],
    recentLogs: [],
    polledAt,
  };
  return computeTier(slice, config);
}

/**
 * Pad `left` and `right` so the combined string is exactly `width`
 * characters wide, with at least one space between them. If the two
 * sides already exceed `width`, fall back to a single space separator
 * (truncation is left to SwiftBar via `trim=false` / `length=`).
 */
function padBetween(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - left.length - right.length);
  return `${left}${" ".repeat(gap)}${right}`;
}

/** Renders the menubar item line (first line of output). */
function renderIconLine(tier: Tier, drivers: string[]): string {
  const tooltip = drivers.length > 0 ? drivers[0] : "All clear";
  const safeTooltip = tooltip.replace(/"/g, "'");
  if (tier === "grey") {
    return `| image=${HOLLOW_GLYPH_B64} templateImage=true tooltip="${safeTooltip}"`;
  }
  const color = TIER_HEX[tier];
  return `| image=${FILLED_GLYPH_B64} templateImage=true color=${color} tooltip="${safeTooltip}"`;
}

/** Renders the Status section (header + daemon + drift summary + last update). */
function renderStatusSection(state: CurrentState, config: Config): string[] {
  const lines: string[] = [];
  lines.push(`Status | size=10 color=${MUTED_HEX} shell=`);

  // Daemon row.
  const d = state.daemon;
  if (d.status === "running") {
    const left = "● Daemon running";
    const right = compactDuration((d.uptimeSeconds ?? 0) * 1000);
    const padded = padBetween(left, right, DAEMON_ROW_LENGTH);
    lines.push(
      `${padded} | color=${TIER_HEX.green} size=12 shell= length=${DAEMON_ROW_LENGTH} trim=false`,
    );
  } else if (d.status === "stopped") {
    lines.push(
      `● Daemon stopped | color=${TIER_HEX.red} size=12 shell=`,
    );
  } else {
    lines.push(
      `● Daemon unresponsive | color=${TIER_HEX.red} size=12 shell=`,
    );
  }

  // Drift summary (count collections whose tier is amber-or-worse).
  const driftingCount =
    state.collections.filter((c) =>
      collectionTier(c, config, state.polledAt) !== "green"
    ).length;
  const summary = driftingCount === 0
    ? "All collections healthy"
    : driftingCount === 1
    ? "1 collection drifting"
    : `${driftingCount} collections drifting`;
  const driftColor = driftingCount === 0 ? TIER_HEX.green : TIER_HEX.amber;
  const driftDot = driftingCount === 0 ? "●" : "○";
  lines.push(`${driftDot} ${summary} | color=${driftColor} shell=`);

  // "Last update" row uses the most recent lastModified across collections.
  let newest: Date | null = null;
  for (const c of state.collections) {
    if (c.lastModified && (!newest || c.lastModified > newest)) {
      newest = c.lastModified;
    }
  }
  const relative = newest ? relativeTime(newest, state.polledAt) : "—";
  lines.push(
    `${
      padBetween("    Last update", relative, DAEMON_ROW_LENGTH)
    } | color=${MUTED_HEX} shell= length=${DAEMON_ROW_LENGTH} trim=false`,
  );

  // In-flight job rows (SPEC §10.3). One row per active job, showing
  // the friendly action label and the elapsed time since startedAt.
  // `shell=` keeps the row informational (no click action).
  for (const job of state.inFlightJobs) {
    const label = actionLabel(job.action);
    const elapsed = compactDuration(
      state.polledAt.getTime() - job.startedAt.getTime(),
    );
    lines.push(
      `⟳ Running: ${label} for ${elapsed} | color=${TIER_HEX.amber} size=12 shell=`,
    );
  }

  return lines;
}

// ─── In-flight action helpers (SPEC §10.3) ────────────────────

/**
 * Find an in-flight job matching the given action+collection. Collection
 * `undefined` matches only global jobs (collection-less). A named
 * collection matches the same action+collection. Returns the first
 * match (PID files are unique per action+collection so this is also
 * the only match in practice).
 */
function findInFlightJob(
  jobs: JobInfo[],
  action: ActionId,
  collection?: string,
): JobInfo | undefined {
  return jobs.find((j) =>
    j.action === action && (j.collection ?? undefined) === collection
  );
}

/**
 * Render the body of a "Running: <verb>… (<elapsed>)" action row given
 * the job and the polled-at time. Used by both the global actions and
 * the per-collection submenu rewriters.
 *
 * The verb is the lowercase form of the shared `actionLabel` lookup
 * (SPEC §10.3 mockup shows "Running: update…" — sentence case mid-row).
 * Keeping the verb derived from the same lookup as the Status rows
 * means menu copy stays consistent if action ids ever change.
 */
function inFlightActionText(job: JobInfo, polledAt: Date): string {
  const elapsed = compactDuration(
    polledAt.getTime() - job.startedAt.getTime(),
  );
  const verb = actionLabel(job.action).toLowerCase();
  return `Running: ${verb}… (${elapsed})`;
}

// Collection names that go into shell arguments must match this. Anything
// outside the set is rejected (no submenu actions emitted) and logged.
// Matches qmd's own collection name conventions: alnum, dot, underscore,
// dash. No slashes, spaces, or shell metacharacters.
const SAFE_COLLECTION_NAME = /^[A-Za-z0-9_.-]+$/;

/** Renders the Collections section: parent row + submenu per collection. */
function renderCollectionsSection(
  state: CurrentState,
  config: Config,
  pluginPath: string,
): string[] {
  const lines: string[] = [];
  lines.push(
    `Collections (${state.collections.length}) | size=10 color=${MUTED_HEX} shell=`,
  );

  for (const c of state.collections) {
    const tier = collectionTier(c, config, state.polledAt);
    const color = TIER_HEX[tier];
    const docCount = NUMBER_FORMAT.format(c.docCount);
    const freshness = c.lastModified
      ? compactDuration(state.polledAt.getTime() - c.lastModified.getTime())
      : "?";

    // Parent row: append "▸" after the freshness so the submenu indicator
    // sits flush with the text content. The pad width stays at
    // DAEMON_ROW_LENGTH but the right side now includes " ▸".
    const left = `● ${c.name}`;
    const right = `${docCount} · ${freshness} ▸`;
    const padded = padBetween(left, right, DAEMON_ROW_LENGTH);
    // No `shell=` on the parent — clicking it opens the submenu naturally;
    // SwiftBar's two-space-indent nesting (Appendix A) does the rest.
    lines.push(
      `${padded} | color=${color} length=${DAEMON_ROW_LENGTH} trim=false`,
    );

    lines.push(
      ...renderCollectionSubmenu(
        c,
        tier,
        config,
        state.polledAt,
        pluginPath,
        state.inFlightJobs,
      ),
    );
  }

  return lines;
}

/**
 * Render the two-space-indented submenu block for a single collection
 * (SPEC §11). Lines are returned without a trailing newline — the caller
 * stitches them into the menu.
 *
 * Order, copying SPEC §11:
 *   header                 (collection name, muted)
 *   <N> docs · <qmdUri>    (info)
 *   Pattern   <pattern>    (info)
 *   Last updated <relative>[ ⚠]   (info, warn glyph if amber-or-worse)
 *   ---
 *   Update this collection
 *   Embed (new chunks only)
 *   Force re-embed all
 *   ---
 *   Reveal in Finder       (direct: open <path>)
 *   Open in Obsidian       (direct: open obsidian://… — gated by hasObsidian)
 *   Copy collection name   (direct: printf | pbcopy)
 *   View context…          (action: show-context)
 *
 * Unsafe names: emit the info block but skip every action row that takes
 * the name as a shell arg. One-line warning to stderr (SPEC §18.1 permits
 * `console.error` for one-off debug logging) so it shows up in SwiftBar's
 * plugin console without dragging the file-logger into the rendering path.
 */
function renderCollectionSubmenu(
  c: CollectionState,
  tier: Tier,
  config: Config,
  polledAt: Date,
  pluginPath: string,
  inFlightJobs: JobInfo[],
): string[] {
  const INDENT = "  ";
  const lines: string[] = [];

  const safeName = SAFE_COLLECTION_NAME.test(c.name);
  if (!safeName) {
    logError(
      "menu",
      `collection name "${c.name}" contains unsafe characters; submenu actions suppressed`,
    );
  }

  // ── Header (collection name) ──
  lines.push(`${INDENT}${c.name} | size=10 color=${MUTED_HEX} shell=`);

  // ── Info rows ──
  const docCount = NUMBER_FORMAT.format(c.docCount);
  lines.push(
    `${INDENT}${docCount} docs · ${c.qmdUri} | size=11 color=${MUTED_HEX} shell=`,
  );
  lines.push(
    `${INDENT}${
      padBetween("Pattern", c.pattern, 36)
    } | size=11 color=${MUTED_HEX} shell=`,
  );

  // "Last updated <relative>[ ⚠]"
  const lastUpdated = c.lastModified
    ? relativeTime(c.lastModified, polledAt)
    : "—";
  const warnGlyph = tier !== "green" ? " ⚠" : "";
  lines.push(
    `${INDENT}${
      padBetween("Last updated", lastUpdated + warnGlyph, 36)
    } | size=11 color=${MUTED_HEX} shell=`,
  );

  // Action rows are skipped wholesale when the name is unsafe — the
  // info block above is enough to show the collection exists.
  if (!safeName) return lines;

  lines.push(`${INDENT}---`);

  // ── Per-collection actions (go through the action runner) ──
  // Mirrors the global-action helper: if a per-collection job is in
  // flight for the same (action, collection) pair, swap the label
  // and append `disabled=true` (SPEC §10.3).
  const collectionAction = (label: string, actionId: ActionId): string => {
    const inFlight = findInFlightJob(inFlightJobs, actionId, c.name);
    const displayLabel = inFlight
      ? inFlightActionText(inFlight, polledAt)
      : label;
    const parts = [
      `bash="${pluginPath}"`,
      `param1="--action"`,
      `param2="${actionId}"`,
      `param3="--collection"`,
      `param4="${c.name}"`,
      "terminal=false",
      "refresh=true",
    ];
    if (inFlight) parts.push("disabled=true");
    return `${INDENT}${displayLabel} | ${parts.join(" ")}`;
  };

  lines.push(collectionAction("↻ Update this collection", "update-collection"));
  lines.push(
    collectionAction("⚡ Embed (new chunks only)", "embed-collection"),
  );
  lines.push(
    collectionAction("⚡⚡ Force re-embed all", "force-reembed-collection"),
  );
  lines.push(`${INDENT}---`);

  // ── Direct shell-outs (don't go through the action runner) ──
  // open(1) with a single param: Reveal in Finder. `param1=` is the path;
  // we don't quote the path inside the value because SwiftBar treats each
  // `paramN=` value as one argument literally. The SAFE_COLLECTION_NAME
  // regex doesn't cover the path itself — qmd controls the path, and any
  // hostile path on disk would already be a much bigger problem than this
  // plugin renders.
  lines.push(
    `${INDENT}📁 Reveal in Finder | bash="open" param1="${c.path}" terminal=false`,
  );

  const showObsidian = c.hasObsidian || !config.ui.hide_obsidian_when_absent;
  if (showObsidian) {
    // Render the row only when the vault is actually present, OR when the
    // user has opted in to seeing the row regardless. The URL itself is
    // harmless when the vault isn't installed — Obsidian simply prompts.
    const obsidianUri = `obsidian://open?vault=${c.name}`;
    lines.push(
      `${INDENT}📓 Open in Obsidian | bash="open" param1="${obsidianUri}" terminal=false`,
    );
  }

  // Copy collection name: `printf %s '<name>' | pbcopy`. Name is already
  // validated by SAFE_COLLECTION_NAME so single-quoting is safe.
  lines.push(
    `${INDENT}⧉ Copy collection name | bash="bash" param1="-c" param2="printf %s '${c.name}' | pbcopy" terminal=false`,
  );

  // View context: re-invoke the plugin under --action show-context. The
  // action handler itself is wired in step 11 as a no-op placeholder.
  lines.push(collectionAction("ⓘ View context…", "show-context"));

  return lines;
}

/** Renders the Global actions section, including the daemon-state-conditional row. */
function renderGlobalActionsSection(
  state: CurrentState,
  pluginPath: string,
): string[] {
  const lines: string[] = [];
  lines.push(`Global actions | size=10 color=${MUTED_HEX} shell=`);

  // Build a single row for a global action. If a global-scope job
  // (`collection === undefined`) is in flight for the same ActionId,
  // the row text becomes "Running: <id>… (Nm)" and `disabled=true` is
  // appended so SwiftBar no-ops the click (SPEC §10.3).
  const action = (
    label: string,
    actionId: ActionId,
    extras: string[] = [],
  ): string => {
    const inFlight = findInFlightJob(state.inFlightJobs, actionId, undefined);
    const displayLabel = inFlight
      ? inFlightActionText(inFlight, state.polledAt)
      : label;
    const parts = [
      `bash="${pluginPath}"`,
      `param1="--action"`,
      `param2="${actionId}"`,
      "terminal=false",
      "refresh=true",
      ...extras,
    ];
    if (inFlight) parts.push("disabled=true");
    return `${displayLabel} | ${parts.join(" ")}`;
  };

  lines.push(action("↻ Update all collections", "update-all"));
  lines.push(action("⚡ Embed all (new only)", "embed-all"));
  lines.push(action("⟳ Restart MCP daemon", "restart-daemon"));

  // Stop / Start row is exclusive (SPEC §10.2).
  if (state.daemon.status === "running") {
    lines.push(action("■ Stop MCP daemon", "stop-daemon"));
  } else {
    lines.push(action("▶ Start MCP daemon", "start-daemon"));
  }

  lines.push(action("🧹 Cleanup orphaned data…", "cleanup"));

  return lines;
}

/**
 * Renders the Copy URL / Show status footer block. When at least one
 * log file exists on disk (newest-first via state.recentLogs), append
 * a "📄 Show last output" row pointing at the most recent log (SPEC
 * §10.2). The row is omitted entirely when no logs are present, so a
 * fresh install doesn't surface a row that would `open -t` a missing
 * path.
 *
 * When `errorContext.consecutiveFailures > 0`, an additional "Show
 * last error" row is appended pointing at `${CACHE_DIR}/error.log`
 * (SPEC §10.4, §16.2). This row is always emitted under degradation
 * regardless of whether the log file currently exists — the user is
 * told the read failed and given a one-click path to the diagnostic.
 */
function renderUtilityFooter(
  endpoint: string,
  recentLogs: CurrentState["recentLogs"],
  errorContext?: ErrorContext,
): string[] {
  // `bash -c "echo -n '<endpoint>' | pbcopy"` keeps the endpoint as a
  // single shell argument so SwiftBar's param-splitting doesn't mangle
  // it. Single-quotes around the endpoint guard against rare URL
  // characters; if the endpoint itself ever contained a single quote
  // we'd need to escape it, but daemon URLs in this plugin never do.
  const safeEndpoint = endpoint.replace(/'/g, "'\\''");
  const lines = [
    `⧉ Copy MCP endpoint URL | bash="bash" param1="-c" param2="echo -n '${safeEndpoint}' | pbcopy" terminal=false`,
    `›_ Show qmd status in Terminal | bash="qmd" param1="status" terminal=true`,
  ];
  if (recentLogs.length > 0) {
    // state.recentLogs is sorted newest-first by lib/state.ts before
    // being handed to the renderer; index 0 is the freshest log.
    const newest = recentLogs[0];
    lines.push(
      `📄 Show last output | bash="open" param1="-t" param2="${newest.path}" terminal=false`,
    );
  }
  // "Show last error" footer fires for either of the two header
  // conditions (consecutive read failures OR config errors) so the user
  // always has a one-click path from the surfaced ⚠ header to the
  // diagnostic log.
  const hasReadFailure = !!errorContext && errorContext.consecutiveFailures > 0;
  const hasConfigError = !!errorContext &&
    (errorContext.configErrors?.length ?? 0) > 0;
  if (hasReadFailure || hasConfigError) {
    const errorLogPath = `${cacheDir()}/error.log`;
    lines.push(
      `⚠ Show last error | bash="open" param1="-t" param2="${errorLogPath}" terminal=false`,
    );
  }
  return lines;
}

/** Renders the Preferences / About footer block (matches first-run menus). */
function renderPreferencesFooter(): string[] {
  return [
    `⚙ Preferences… | bash="open" param1="-t" param2="${CONFIG_PATH}" terminal=false`,
    `ⓘ About qmd-swiftbar | bash="open" param1="https://github.com/ggfevans/qmd-swiftbar" terminal=false`,
  ];
}

// ─── Error-state degradation (SPEC §10.4, §16.2) ──────────────

/**
 * Context the caller passes to surface a degraded-read state. When
 * `consecutiveFailures > 0` the menu renders a top-of-dropdown
 * "⚠ Status read failed — using last poll (Nm ago)" header and a
 * "Show last error" footer row.
 *
 * `lastGoodAt` is the pollTimestamp of the snapshot whose data is
 * being reused; passing `null` falls back to omitting the "(Nm ago)"
 * suffix.
 *
 * `configErrors`, when non-empty, drives the "⚠ Config error — see
 * logs" header (SPEC §10.4, §16.2 — config:invalid / config:parse).
 * The header is emitted independently of `consecutiveFailures` so a
 * malformed config still surfaces even when state reads succeed.
 */
export type ErrorContext = {
  lastGoodAt: Date | null;
  consecutiveFailures: number;
  configErrors?: string[];
};

/**
 * Render the degradation header. Emitted only when the caller has
 * supplied an `errorContext` with `consecutiveFailures > 0`, OR when
 * the rendered state itself carries `status.error` (defensive fallback
 * for callers that forgot to pass errorContext).
 *
 * The config-error header (`⚠ Config error — see logs`) is emitted
 * separately above the read-failure header when `errorContext.configErrors`
 * is non-empty — both can fire on the same poll when a corrupt config
 * and a read failure coincide.
 */
function renderErrorHeader(
  state: CurrentState,
  errorContext: ErrorContext | undefined,
): string[] {
  const failures = errorContext?.consecutiveFailures ?? 0;
  const stateHasError = !!state.status.error;
  const configErrors = errorContext?.configErrors ?? [];
  const hasConfigErrors = configErrors.length > 0;

  if (failures === 0 && !stateHasError && !hasConfigErrors) return [];

  const lines: string[] = [];

  if (hasConfigErrors) {
    lines.push(
      `⚠ Config error — see logs | size=10 color=${TIER_HEX.red} shell=`,
    );
  }

  if (failures > 0 || stateHasError) {
    const lastGoodAt = errorContext?.lastGoodAt ?? null;
    const relative = lastGoodAt
      ? relativeTime(lastGoodAt, state.polledAt)
      : null;
    const suffix = relative ? ` (${relative})` : "";
    lines.push(
      `⚠ Status read failed — using last poll${suffix} | size=10 color=${TIER_HEX.red} shell=`,
    );
  }

  lines.push("---");
  return lines;
}

/**
 * Render the full healthy menu (SPEC §10.2). The result is a single
 * string of newline-joined SwiftBar lines with a trailing newline. The
 * caller is expected to `console.log` it as-is.
 *
 * In-flight job rendering (SPEC §10.3) is now wired in: when
 * `state.inFlightJobs` is non-empty, the Status section gains
 * "⟳ Running:" rows and the matching action rows are rewritten as
 * "Running: <id>… (Nm)" with `disabled=true`.
 *
 * Confirmation dialogs for destructive actions (force-reembed,
 * cleanup) are gated inside `runAction` (lib/actions.ts), not here —
 * the menu row simply re-invokes the plugin with `--action <id>` and
 * the runner shows the dialog before spawning.
 *
 * The "📄 Show last output" row appears in the utility footer when
 * `state.recentLogs` is non-empty (SPEC §10.2).
 *
 * Error-state degradation (SPEC §10.4, §16.2): when `errorContext`
 * indicates consecutive read failures, a "⚠ Status read failed — using
 * last poll (Nm ago)" header is prepended and a "Show last error"
 * footer row is appended pointing at the error log. The caller (the
 * poll loop in qmd.30s.ts) composes these inputs from
 * `readCurrentStateWithSnapshot`.
 */
export function renderMenu(
  state: CurrentState,
  tier: TierReason,
  config: Config,
  errorContext?: ErrorContext,
): string {
  const pluginPath = getPluginPath();
  const lines: string[] = [];

  lines.push(renderIconLine(tier.tier, tier.drivers));
  lines.push("---");

  // Error-state header sits at the very top of the dropdown, before
  // the Status section. SPEC §10.4 puts it ahead of everything so the
  // user sees the degraded read at a glance.
  lines.push(...renderErrorHeader(state, errorContext));

  lines.push(...renderStatusSection(state, config));
  lines.push("---");

  lines.push(...renderCollectionsSection(state, config, pluginPath));
  lines.push("---");

  lines.push(...renderGlobalActionsSection(state, pluginPath));
  lines.push("---");

  lines.push(
    ...renderUtilityFooter(
      state.daemon.endpoint,
      state.recentLogs,
      errorContext,
    ),
  );
  lines.push("---");

  lines.push(...renderPreferencesFooter());

  return lines.join("\n") + "\n";
}
