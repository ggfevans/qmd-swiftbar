// Homebrew install prefixes that GUI apps (launchd) do not put on PATH:
// Apple Silicon first, then Intel.
const HOMEBREW_BINS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** Pure: prepend Homebrew prefixes to an existing PATH, skipping duplicates. */
export function buildExecPath(existing: string | undefined): string {
  const parts = existing ? existing.split(":") : [];
  const missing = HOMEBREW_BINS.filter((p) => !parts.includes(p));
  return [...missing, ...parts].join(":");
}

/** Env override passed to Deno.Command for any qmd-spawning process. */
export function qmdExecEnv(): { PATH: string } {
  return { PATH: buildExecPath(Deno.env.get("PATH")) };
}
