// ext4 metadata operations (journal updates, inode table writes) can move
// `df` usage by a block even without user-visible file changes, so on-change
// mode treats a usage delta of up to one filesystem block as "unchanged".
export const ON_CHANGE_THRESHOLD_BYTES = 4096;

export function formatBytes(bytes: number): string {
  return `${bytes} bytes (${(bytes / (1 << 30)).toFixed(2)} GiB)`;
}

export const ON_CHANGE_CRITERIA = `request a commit only if |usage at teardown - usage at mount| > ${ON_CHANGE_THRESHOLD_BYTES} bytes`;

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
  const prefix = `on-change commit check (${ON_CHANGE_CRITERIA}):`;

  if (!initialUsageBytesStr) {
    return {
      commit: true,
      summary: `${prefix} no filesystem usage was recorded at mount time, so changes cannot be detected -> verdict: request commit (to be safe)`,
    };
  }

  const initialUsageBytes = parseInt(initialUsageBytesStr, 10);
  if (isNaN(initialUsageBytes)) {
    return {
      commit: true,
      summary: `${prefix} filesystem usage recorded at mount time is invalid ("${initialUsageBytesStr}"), so changes cannot be detected -> verdict: request commit (to be safe)`,
    };
  }

  if (fsDiskUsageBytes === null) {
    return {
      commit: true,
      summary: `${prefix} usage at mount ${formatBytes(initialUsageBytes)}, usage at teardown could not be measured, so changes cannot be detected -> verdict: request commit (to be safe)`,
    };
  }

  const delta = fsDiskUsageBytes - initialUsageBytes;
  const measurements = `usage at mount ${formatBytes(initialUsageBytes)}, usage at teardown ${formatBytes(fsDiskUsageBytes)}, delta ${delta >= 0 ? "+" : "-"}${Math.abs(delta)} bytes`;

  if (Math.abs(delta) <= ON_CHANGE_THRESHOLD_BYTES) {
    return {
      commit: false,
      summary: `${prefix} ${measurements} -> verdict: skip commit (delta within ${ON_CHANGE_THRESHOLD_BYTES} byte threshold, filesystem unchanged)`,
    };
  }

  return {
    commit: true,
    summary: `${prefix} ${measurements} -> verdict: request commit (delta exceeds ${ON_CHANGE_THRESHOLD_BYTES} byte threshold, filesystem changed)`,
  };
}
