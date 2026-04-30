/**
 * Standalone commit entry point for `stickydisk/commit`.
 *
 * Reads expose-id, key, and path from action inputs (not state),
 * then runs the same unmount → flush → commit logic as post.ts.
 */
import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";
import { createStickyDiskClient } from "./utils";

const execAsync = promisify(exec);

async function commitStickydisk(
  exposeId: string,
  stickyDiskKey: string,
  fsDiskUsageBytes: number | null,
): Promise<void> {
  core.info(
    `Committing sticky disk ${stickyDiskKey} with expose ID ${exposeId}`,
  );

  try {
    const client = await createStickyDiskClient();

    const commitRequest: Record<string, unknown> = {
      exposeId,
      stickyDiskKey,
      vmId: process.env.BLACKSMITH_VM_ID || "",
      shouldCommit: true,
      repoName: process.env.GITHUB_REPO_NAME || "",
      stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || "",
    };

    if (fsDiskUsageBytes !== null && fsDiskUsageBytes > 0) {
      commitRequest.fsDiskUsageBytes = BigInt(fsDiskUsageBytes);
    }

    await client.commitStickyDisk(commitRequest, { timeoutMs: 30000 });
    core.info(
      `Successfully committed sticky disk ${stickyDiskKey} with expose ID ${exposeId}`,
    );
  } catch (error) {
    core.warning(
      `Error committing sticky disk: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getDeviceFromMount(mountPoint: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`findmnt -n -o SOURCE "${mountPoint}"`);
    const device = stdout.trim();
    if (device) return device;
  } catch {
    /* fall through */
  }
  try {
    const { stdout } = await execAsync(`mount | grep " ${mountPoint} "`);
    const match = stdout.match(/^(\/dev\/\S+)/);
    if (match) return match[1];
  } catch {
    /* fall through */
  }
  return null;
}

const FLUSH_TIMEOUT_SECS = 10;

async function flushBlockDevice(devicePath: string): Promise<void> {
  const deviceName = devicePath.replace("/dev/", "");
  if (!deviceName) return;

  const startTime = Date.now();
  try {
    await execAsync(
      `timeout ${FLUSH_TIMEOUT_SECS} sudo blockdev --flushbufs ${devicePath}`,
    );
    core.info(`guest flush duration: ${Date.now() - startTime}ms, device: ${devicePath}`);
  } catch {
    core.info(`guest flush failed for ${devicePath} after ${Date.now() - startTime}ms`);
  }
}

/** Resolve leading `~` to $HOME since mount paths are always expanded. */
function resolveTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return (process.env.HOME ?? "/home/runner") + p.slice(1);
  }
  return p;
}

async function run(): Promise<void> {
  const stickyDiskPath = resolveTilde(core.getInput("path", { required: true }));
  const exposeId = core.getInput("expose-id", { required: true });
  const stickyDiskKey = core.getInput("key", { required: true });

  core.info(`Committing stickydisk: path=${stickyDiskPath} key=${stickyDiskKey} expose-id=${exposeId}`);

  try {
    // Verify mount
    const { stdout: mountOutput } = await execAsync(
      `mount | grep "${stickyDiskPath}"`,
    );
    if (!mountOutput) {
      core.warning(`${stickyDiskPath} is not mounted, skipping commit`);
      return;
    }

    const devicePath = await getDeviceFromMount(stickyDiskPath);

    // Sync and measure usage
    await execAsync("sync");
    let fsDiskUsageBytes: number | null = null;
    try {
      const { stdout } = await execAsync(
        `df -B1 --output=used "${stickyDiskPath}" | tail -n1`,
      );
      const parsed = parseInt(stdout.trim(), 10);
      if (!isNaN(parsed) && parsed > 0) {
        fsDiskUsageBytes = parsed;
        core.info(`Filesystem usage: ${fsDiskUsageBytes} bytes`);
      }
    } catch {
      /* non-fatal */
    }

    // Drop caches for clean unmount
    await execAsync("sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'");

    // Unmount with retries
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await execAsync(`sudo umount "${stickyDiskPath}"`);
        core.info(`Successfully unmounted ${stickyDiskPath}`);
        break;
      } catch (error) {
        if (attempt === 10) throw error;
        core.warning(`Unmount failed, retrying (${attempt}/10)...`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    // Flush block device
    if (devicePath) {
      await flushBlockDevice(devicePath);
    }

    // Commit
    await commitStickydisk(exposeId, stickyDiskKey, fsDiskUsageBytes);
  } catch (error) {
    core.warning(
      `Failed to commit sticky disk at ${stickyDiskPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

run();
