// ext4 metadata operations (journal updates, inode table writes) can move
// `df` usage by a block even without user-visible file changes, so on-change
// mode treats a usage delta of up to one filesystem block as "unchanged".
export const ON_CHANGE_THRESHOLD_BYTES = 4096;

export function formatBytes(bytes: number): string {
  return `${bytes} bytes (${(bytes / (1 << 30)).toFixed(2)} GiB)`;
}

export const ON_CHANGE_CRITERIA = `request a commit only if filesystem usage changes by more than ${ON_CHANGE_THRESHOLD_BYTES} bytes between mount and teardown`;

export interface OnChangeVerdict {
  commit: boolean;
  // Human-readable one-liner with the measurements, the criteria and the
  // verdict, suitable for the job log.
  summary: string;
}

/**
 * Decides whether a commit should be requested for an on-change disk from the filesystem
 * usage recorded at mount time (as saved in action state) and the usage
 * measured right before unmount. Whenever either measurement is unavailable
 * a commit is requested, since a missed change is worse than a redundant
 * commit.
 */
export function evaluateOnChangeCommit(
  initialUsageBytesStr: string,
  fsDiskUsageBytes: number | null,
): OnChangeVerdict {
  const prefix = "on-change commit check:";

  if (!initialUsageBytesStr) {
    return {
      commit: true,
      summary: `${prefix} no filesystem usage was recorded at mount time, so the change cannot be measured -> verdict: request commit (to be safe)`,
    };
  }

  const initialUsageBytes = parseInt(initialUsageBytesStr, 10);
  if (isNaN(initialUsageBytes)) {
    return {
      commit: true,
      summary: `${prefix} filesystem usage recorded at mount time is invalid ("${initialUsageBytesStr}"), so the change cannot be measured -> verdict: request commit (to be safe)`,
    };
  }

  if (fsDiskUsageBytes === null) {
    return {
      commit: true,
      summary: `${prefix} filesystem usage at teardown could not be measured, so the change is unknown -> verdict: request commit (to be safe)`,
    };
  }

  const delta = fsDiskUsageBytes - initialUsageBytes;
  const change = `filesystem usage changed by ${delta >= 0 ? "+" : "-"}${Math.abs(delta)} bytes between mount and teardown`;

  if (Math.abs(delta) <= ON_CHANGE_THRESHOLD_BYTES) {
    return {
      commit: false,
      summary: `${prefix} ${change} -> verdict: skip commit (change is within the ${ON_CHANGE_THRESHOLD_BYTES} byte threshold)`,
    };
  }

  return {
    commit: true,
    summary: `${prefix} ${change} -> verdict: request commit (change exceeds the ${ON_CHANGE_THRESHOLD_BYTES} byte threshold)`,
  };
}
