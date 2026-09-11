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
