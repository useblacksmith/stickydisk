import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";
import { getState } from "@actions/core";
import { createStickyDiskClient } from "./utils";

const execAsync = promisify(exec);

async function commitStickydisk(
  exposeId: string,
  stickyDiskKey: string
): Promise<void> {
  core.info(
    `Committing sticky disk ${stickyDiskKey} with expose ID ${exposeId}`
  );
  if (!exposeId || !stickyDiskKey) {
    core.warning(
      "No expose ID or sticky disk key found, cannot report sticky disk to Blacksmith"
    );
    return;
  }

  try {
    const client = await createStickyDiskClient();
    await client.commitStickyDisk(
      {
        exposeId,
        stickyDiskKey,
        vmId: process.env.VM_ID || "",
        shouldCommit: true,
        repoName: process.env.GITHUB_REPO_NAME || "",
        stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || "",
      },
      {
        timeoutMs: 30000,
      }
    );
    core.info(
      `Successfully committed sticky disk ${stickyDiskKey} with expose ID ${exposeId}`
    );
  } catch (error) {
    core.warning(
      `Error committing sticky disk: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function cleanupStickyDiskWithoutCommit(
  exposeId: string,
  stickyDiskKey: string
): Promise<void> {
  core.info(
    `Cleaning up sticky disk ${stickyDiskKey} with expose ID ${exposeId}`
  );
  if (!exposeId || !stickyDiskKey) {
    core.warning(
      "No expose ID or sticky disk key found, cannot report sticky disk to Blacksmith"
    );
    return;
  }

  try {
    const client = await createStickyDiskClient();
    await client.commitStickyDisk(
      {
        exposeId,
        stickyDiskKey,
        vmId: process.env.VM_ID || "",
        shouldCommit: false,
        repoName: process.env.GITHUB_REPO_NAME || "",
        stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || "",
      },
      {
        timeoutMs: 30000,
      }
    );
  } catch (error) {
    core.warning(
      `Error reporting build failed: ${error instanceof Error ? error.message : String(error)}`
    );
    // We don't want to fail the build if this fails so we swallow the error.
  }
}

async function run(): Promise<void> {
  const stickyDiskPath = getState("STICKYDISK_PATH");
  const exposeId = getState("STICKYDISK_EXPOSE_ID");
  const stickyDiskKey = getState("STICKYDISK_KEY");

  if (!stickyDiskPath) {
    core.debug("No STICKYDISK_PATH in state, skipping unmount");
    return;
  }

  try {
    // Check if path is mounted.
    try {
      const { stdout: mountOutput } = await execAsync(
        `mount | grep ${stickyDiskPath}`
      );
      if (!mountOutput) {
        core.debug(`${stickyDiskPath} is not mounted, skipping unmount`);
        return;
      }
    } catch {
      // grep returns non-zero if no match found
      core.debug(`${stickyDiskPath} is not mounted, skipping unmount`);
      return;
    }

    // Ensure all pending writes are flushed to disk before unmounting.
    await execAsync("sync");
    // Drop page cache, dentries and inodes to ensure clean unmount
    // This helps prevent "device is busy" errors during unmount
    await execAsync("sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'");

    // Unmount with retries.
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await execAsync(`sudo umount ${stickyDiskPath}`);
        core.info(`Successfully unmounted ${stickyDiskPath}`);
        break;
      } catch (error) {
        if (attempt === 10) {
          throw error;
        }
        core.warning(`Unmount failed, retrying (${attempt}/10)...`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    const stickyDiskError = getState("STICKYDISK_ERROR") === "true";
    if (!stickyDiskError) {
      await commitStickydisk(exposeId, stickyDiskKey);
    } else {
      await cleanupStickyDiskWithoutCommit(exposeId, stickyDiskKey);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.warning(
        `Failed to cleanup and commit sticky disk at ${stickyDiskPath}: ${error}`
      );
    }
  }
}

run();
