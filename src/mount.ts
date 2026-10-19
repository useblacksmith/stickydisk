import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Runs a binary with an argv array and no shell, so a mount path is only ever
 * a filename to the child process. `path` is an action input and can carry
 * `$(...)`, backticks, quotes, or `;` from a workflow's untrusted data.
 */
export type CommandRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const runCommand: CommandRunner = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, args);
  return { stdout: String(stdout), stderr: String(stderr) };
};

/**
 * Source device of a `mount` listing line whose target is exactly
 * `mountPoint`, e.g. `/dev/vdb on /mnt/cache type ext4 (rw)` → `/dev/vdb`.
 */
export function parseMountSource(
  mountOutput: string,
  mountPoint: string,
): string | null {
  for (const line of mountOutput.split("\n")) {
    const match = line.match(/^(\S+) on (.+) type \S+ /);
    if (match && match[2] === mountPoint) {
      return match[1];
    }
  }
  return null;
}

/** Device mounted at `mountPoint`, or null when nothing is mounted there. */
export async function findMountedDevice(
  mountPoint: string,
  run: CommandRunner = runCommand,
): Promise<string | null> {
  try {
    const { stdout } = await run("findmnt", [
      "-n",
      "-o",
      "SOURCE",
      "--mountpoint",
      mountPoint,
    ]);
    const device = stdout.trim();
    if (device) {
      return device;
    }
  } catch {
    // findmnt exits non-zero when the path is not a mount point; fall through
    // to the `mount` listing in case findmnt itself is unavailable.
  }

  try {
    const { stdout } = await run("mount", []);
    return parseMountSource(stdout, mountPoint);
  } catch {
    return null;
  }
}

/** The `used` column of `df -B1` for `mountPoint`, as printed. */
export async function getFilesystemUsedField(
  mountPoint: string,
  run: CommandRunner = runCommand,
): Promise<string> {
  const { stdout } = await run("df", [
    "-B1",
    "--output=used",
    "--",
    mountPoint,
  ]);
  const lines = stdout.trim().split("\n");
  return lines[lines.length - 1].trim();
}

export async function unmount(
  mountPoint: string,
  run: CommandRunner = runCommand,
): Promise<void> {
  await run("sudo", ["umount", "--", mountPoint]);
}

export const TRIM_TIMEOUT_SECS = 60;
const TIMEOUT_EXIT_CODE = 124;

export interface TrimResult {
  outcome: "trimmed" | "timed_out" | "failed";
  durationMs: number;
  /** Byte count from `fstrim -v`, when the output carried one. */
  trimmedBytes: number | null;
  /** Error or stderr text for a non-`trimmed` outcome. */
  detail: string;
}

/** Byte count from `fstrim -v` output such as `/mnt: 1 GiB (1073741824 bytes) trimmed`. */
export function parseTrimmedBytes(fstrimOutput: string): number | null {
  const match = fstrimOutput.match(/\((\d+) bytes\) trimmed/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Best-effort `fstrim` of the filesystem at `mountPoint`, so blocks freed
 * during the job are discarded before the device is unmounted and committed.
 * Never throws: a missing binary, a filesystem or device without discard
 * support, and the timeout all come back as a non-`trimmed` outcome.
 */
export async function trimFilesystem(
  mountPoint: string,
  run: CommandRunner = runCommand,
): Promise<TrimResult> {
  const start = Date.now();
  try {
    const { stdout } = await run("timeout", [
      String(TRIM_TIMEOUT_SECS),
      "sudo",
      "fstrim",
      "-v",
      "--",
      mountPoint,
    ]);
    return {
      outcome: "trimmed",
      durationMs: Date.now() - start,
      trimmedBytes: parseTrimmedBytes(stdout),
      detail: "",
    };
  } catch (error) {
    const durationMs = Date.now() - start;
    const { code, stderr } = (error ?? {}) as {
      code?: unknown;
      stderr?: unknown;
    };
    if (code === TIMEOUT_EXIT_CODE) {
      return {
        outcome: "timed_out",
        durationMs,
        trimmedBytes: null,
        detail: `timed out after ${TRIM_TIMEOUT_SECS}s`,
      };
    }
    const stderrText = typeof stderr === "string" ? stderr.trim() : "";
    const detail =
      stderrText ||
      (error instanceof Error ? error.message : String(error)).trim();
    return { outcome: "failed", durationMs, trimmedBytes: null, detail };
  }
}
