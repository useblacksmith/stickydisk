import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";
import { getState } from "@actions/core";
import { createStickyDiskClient } from "./utils";
import { checkPreviousStepFailures } from "./step-checker";

const execAsync = promisify(exec);

async function commitStickydisk(
  exposeId: string,
  stickyDiskKey: string,
  fsDiskUsageBytes: number | null,
): Promise<void> {
  core.info(
    `Committing sticky disk ${stickyDiskKey} with expose ID ${exposeId}`,
  );
  if (!exposeId || !stickyDiskKey) {
    core.warning(
      "No expose ID or sticky disk key found, cannot report sticky disk to Blacksmith",
    );
    return;
  }

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

    // Only include fsDiskUsageBytes if we have valid data (> 0)
    // This allows storage agent to fall back to previous sizing logic when data is unavailable
    if (fsDiskUsageBytes !== null && fsDiskUsageBytes > 0) {
      commitRequest.fsDiskUsageBytes = BigInt(fsDiskUsageBytes);
      core.debug(`Reporting fs usage: ${fsDiskUsageBytes} bytes`);
    } else {
      core.debug(
        "No fs usage data available, storage agent will use fallback sizing",
      );
    }

    await client.commitStickyDisk(commitRequest, {
      timeoutMs: 30000,
    });
    core.info(
      `Successfully committed sticky disk ${stickyDiskKey} with expose ID ${exposeId}`,
    );
  } catch (error) {
    core.warning(
      `Error committing sticky disk: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function cleanupStickyDiskWithoutCommit(
  exposeId: string,
  stickyDiskKey: string,
): Promise<void> {
  core.info(
    `Cleaning up sticky disk ${stickyDiskKey} with expose ID ${exposeId}`,
  );
  if (!exposeId || !stickyDiskKey) {
    core.warning(
      "No expose ID or sticky disk key found, cannot report sticky disk to Blacksmith",
    );
    return;
  }

  try {
    const client = await createStickyDiskClient();
    await client.commitStickyDisk(
      {
        exposeId,
        stickyDiskKey,
        vmId: process.env.BLACKSMITH_VM_ID || "",
        shouldCommit: false,
        repoName: process.env.GITHUB_REPO_NAME || "",
        stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || "",
        // No need to collect fs usage when not committing
      },
      {
        timeoutMs: 30000,
      },
    );
  } catch (error) {
    core.warning(
      `Error reporting build failed: ${error instanceof Error ? error.message : String(error)}`,
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
        `mount | grep "${stickyDiskPath}"`,
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

    // Ensure all pending writes are flushed to disk before collecting usage.
    await execAsync("sync");

    // Get filesystem usage BEFORE unmounting (critical timing)
    let fsDiskUsageBytes: number | null = null;
    try {
      const { stdout } = await execAsync(
        `df -B1 --output=used "${stickyDiskPath}" | tail -n1`,
      );
      const parsedValue = parseInt(stdout.trim(), 10);

      if (isNaN(parsedValue) || parsedValue <= 0) {
        core.warning(
          `Invalid filesystem usage value from df: "${stdout.trim()}". Will not report fs usage.`,
        );
      } else {
        fsDiskUsageBytes = parsedValue;
        core.info(
          `Filesystem usage: ${fsDiskUsageBytes} bytes (${(fsDiskUsageBytes / (1 << 30)).toFixed(2)} GiB)`,
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      core.warning(
        `Failed to get filesystem usage: ${errorMsg}. Will not report fs usage.`,
      );
    }

    // Drop page cache, dentries and inodes to ensure clean unmount
    // This helps prevent "device is busy" errors during unmount
    await execAsync("sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'");

    // Unmount with retries.
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await execAsync(`sudo umount "${stickyDiskPath}"`);
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

    // Check for previous step failures before committing
    if (!stickyDiskError) {
      core.info(
        "Checking for previous step failures before committing sticky disk",
      );
      const failureCheck = await checkPreviousStepFailures();

      if (failureCheck.error) {
        core.warning(
          `Unable to check for previous step failures: ${failureCheck.error}`,
        );
        core.warning(
          "Skipping sticky disk commit due to ambiguity in failure detection",
        );
        await cleanupStickyDiskWithoutCommit(exposeId, stickyDiskKey);
      } else if (failureCheck.hasFailures) {
        core.warning(
          `Found ${failureCheck.failedCount} failed/cancelled steps in previous workflow steps`,
        );
        if (failureCheck.failedSteps) {
          failureCheck.failedSteps.forEach((step) => {
            core.warning(
              `  - Step: ${step.stepName || step.action || "unknown"} (${step.result})`,
            );
          });
        }
        core.warning(
          "Skipping sticky disk commit due to previous step failures",
        );
        await cleanupStickyDiskWithoutCommit(exposeId, stickyDiskKey);
      } else {
        // No failures detected
        core.info("No previous step failures detected, committing sticky disk");
        await commitStickydisk(exposeId, stickyDiskKey, fsDiskUsageBytes);
      }
    } else {
      core.warning(
        "Skipping sticky disk commit due to sticky disk error during setup",
      );
      await cleanupStickyDiskWithoutCommit(exposeId, stickyDiskKey);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.warning(
        `Failed to cleanup and commit sticky disk at ${stickyDiskPath}: ${error}`,
      );
    }
  }
}

run();
