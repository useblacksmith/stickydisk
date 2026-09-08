// ext4 metadata operations (journal updates, inode table writes) can move
// `df` usage by a block even without user-visible file changes, so on-change
// mode treats a usage delta of up to one filesystem block as "unchanged".
export const ON_CHANGE_THRESHOLD_BYTES = 4096;

export function formatBytes(bytes: number): string {
  return `${bytes} bytes (${(bytes / (1 << 30)).toFixed(2)} GiB)`;
}

export const ON_CHANGE_CRITERIA = `commit is requested only if usage changes by more than ${ON_CHANGE_THRESHOLD_BYTES} bytes`;

export interface OnChangeVerdict {
  commit: boolean;
  // Human-readable one-liner with the verdict and the measured change,
  // suitable for the job log.
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
  if (!initialUsageBytesStr) {
    return {
      commit: true,
      summary: "on-change: requesting commit, no usage recorded at mount",
    };
  }

  const initialUsageBytes = parseInt(initialUsageBytesStr, 10);
  if (isNaN(initialUsageBytes)) {
    return {
      commit: true,
      summary: `on-change: requesting commit, usage recorded at mount is invalid ("${initialUsageBytesStr}")`,
    };
  }

  if (fsDiskUsageBytes === null) {
    return {
      commit: true,
      summary:
        "on-change: requesting commit, could not measure usage at teardown",
    };
  }

  const delta = fsDiskUsageBytes - initialUsageBytes;
  const change = `usage changed by ${delta >= 0 ? "+" : "-"}${Math.abs(delta)} bytes`;

  if (Math.abs(delta) <= ON_CHANGE_THRESHOLD_BYTES) {
    return {
      commit: false,
      summary: `on-change: not committing, ${change} (within the ${ON_CHANGE_THRESHOLD_BYTES} byte threshold)`,
    };
  }

  return {
    commit: true,
    summary: `on-change: requesting commit, ${change} (over the ${ON_CHANGE_THRESHOLD_BYTES} byte threshold)`,
  };
}
