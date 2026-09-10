import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";
import { getState } from "@actions/core";
import { createStickyDiskClient } from "./utils";
import { CommitIntent, commitIntentFromMode } from "./commit-intent";
import { evaluateOnChangeCommit, formatBytes } from "./on-change";
import { checkPreviousStepFailures } from "./step-checker";
import {
  MountReport,
  SkipReason,
  parseStateMs,
  sendMountReport,
} from "./mount-report";

const execAsync = promisify(exec);

async function commitStickydisk(
  exposeId: string,
  stickyDiskKey: string,
  fsDiskUsageBytes: number | null,
): Promise<void> {
  core.info(
    `Requesting commit of sticky disk ${stickyDiskKey} with expose ID ${exposeId}`,
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
    // The host applies the commit at VM teardown, after this step has ended;
    // this only confirms the request was accepted.
    core.info(
      `Sticky disk commit requested for ${stickyDiskKey} with expose ID ${exposeId}; applied at VM shutdown`,
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
  reason: string,
): Promise<void> {
  core.info(
    `Not committing sticky disk ${stickyDiskKey} with expose ID ${exposeId}: ${reason}`,
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

async function getDeviceFromMount(mountPoint: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`findmnt -n -o SOURCE "${mountPoint}"`);
    const device = stdout.trim();
    if (device) {
      return device;
    }
  } catch {
    core.info(`findmnt failed for ${mountPoint}, trying mount command`);
  }

  try {
    const { stdout } = await execAsync(`mount | grep " ${mountPoint} "`);
    const match = stdout.match(/^(\/dev\/\S+)/);
    if (match) {
      return match[1];
    }
  } catch {
    core.info(`mount grep failed for ${mountPoint}`);
  }

  return null;
}

const FLUSH_TIMEOUT_SECS = 10;
const TIMEOUT_EXIT_CODE = 124;

async function flushBlockDevice(devicePath: string): Promise<void> {
  const deviceName = devicePath.replace("/dev/", "");
  if (!deviceName) {
    core.info(`Could not extract device name from ${devicePath}`);
    return;
  }

  const statPath = `/sys/block/${deviceName}/stat`;

  let beforeStats = "";
  try {
    const { stdout } = await execAsync(`cat ${statPath}`);
    beforeStats = stdout.trim();
  } catch {
    core.info(`Could not read block device stats before flush: ${statPath}`);
  }

  const startTime = Date.now();
  try {
    const { stdout, stderr } = await execAsync(
      `timeout ${FLUSH_TIMEOUT_SECS} sudo blockdev --flushbufs ${devicePath}; echo "EXIT_CODE:$?"`,
    );
    const duration = Date.now() - startTime;

    // Parse exit code from output
    const exitCodeMatch = stdout.match(/EXIT_CODE:(\d+)/);
    const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;

    if (exitCode === TIMEOUT_EXIT_CODE) {
      core.info(
        `guest flush timed out for ${devicePath} after ${FLUSH_TIMEOUT_SECS}s`,
      );
      return;
    }

    if (exitCode !== 0) {
      core.info(
        `guest flush failed for ${devicePath} after ${duration}ms: exit code ${exitCode}, stderr: ${stderr}`,
      );
      return;
    }

    let afterStats = "";
    try {
      const { stdout } = await execAsync(`cat ${statPath}`);
      afterStats = stdout.trim();
    } catch {
      core.info(`Could not read block device stats after flush: ${statPath}`);
    }

    core.info(
      `guest flush duration: ${duration}ms, device: ${devicePath}, before_stats: ${beforeStats}, after_stats: ${afterStats}`,
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    core.info(
      `guest flush failed for ${devicePath} after ${duration}ms: ${errorMsg}`,
    );
  }
}

async function run(): Promise<void> {
  const stickyDiskPath = getState("STICKYDISK_PATH");
  const exposeId = getState("STICKYDISK_EXPOSE_ID");
  const stickyDiskKey = getState("STICKYDISK_KEY");
  const commitIntent = commitIntentFromMode(
    getState("STICKYDISK_COMMIT_MODE") || "true",
  );
  const initialUsageBytesStr = getState("STICKYDISK_INITIAL_USAGE_BYTES");
  const wasFormatted = getState("STICKYDISK_WAS_FORMATTED");
  const commitEarlyDenyReason = getState("STICKYDISK_COMMIT_EARLY_DENY_REASON");
  const stickyDiskError = getState("STICKYDISK_ERROR") === "true";

  if (!stickyDiskPath) {
    core.debug("No STICKYDISK_PATH in state, skipping unmount");
    return;
  }

  const report: MountReport = {
    expose_id: exposeId,
    sticky_disk_key: stickyDiskKey,
    setup_outcome: stickyDiskError ? "setup_fallback" : "mounted",
    skip_reason: "",
    was_formatted: wasFormatted === "true",
    format_ms: parseStateMs(getState("STICKYDISK_FORMAT_MS")),
    mount_ms: parseStateMs(getState("STICKYDISK_MOUNT_MS")),
    unmount_ms: 0,
  };
  const skip = (reason: SkipReason): void => {
    report.skip_reason = reason;
  };

  const logNotMounted = (): void => {
    if (stickyDiskError) {
      core.info(
        `Skipping unmount and commit for ${stickyDiskPath}: the sticky disk mount failed during setup, so there is nothing to unmount and committing could clobber existing cached data`,
      );
    } else {
      core.debug(`${stickyDiskPath} is not mounted, skipping unmount`);
    }
  };

  try {
    // Check if path is mounted and get the device name for later flush
    let devicePath: string | null = null;
    try {
      const { stdout: mountOutput } = await execAsync(
        `mount | grep "${stickyDiskPath}"`,
      );
      if (!mountOutput) {
        logNotMounted();
        skip(stickyDiskError ? "setup_error" : "not_mounted");
        return;
      }
      devicePath = await getDeviceFromMount(stickyDiskPath);
      if (devicePath) {
        core.info(
          `Found device ${devicePath} for mount point ${stickyDiskPath}`,
        );
      }
    } catch {
      // grep returns non-zero if no match found
      logNotMounted();
      skip(stickyDiskError ? "setup_error" : "not_mounted");
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
        core.info(`Filesystem usage: ${formatBytes(fsDiskUsageBytes)}`);
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

    // Unmount with retries; the duration covers the retries and is kept
    // when the last attempt fails.
    const unmountStart = Date.now();
    try {
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
    } finally {
      report.unmount_ms = Date.now() - unmountStart;
    }

    // Flush block device buffers after unmount to ensure data durability
    // before the Ceph RBD snapshot is taken. The device is still mapped even though unmounted.
    if (devicePath) {
      await flushBlockDevice(devicePath);
    } else {
      core.info(
        "Skipping durability flush: device path not found for mount point",
      );
    }

    // Determine whether to commit based on commit mode
    if (commitIntent === CommitIntent.NEVER) {
      skip("commit_false");
      await cleanupStickyDiskWithoutCommit(
        exposeId,
        stickyDiskKey,
        "commit mode is 'false' (read-only consumer)",
      );
      return;
    }

    // The host already told us at mount time that this job's writes are
    // discarded (e.g. branch protection), so there is nothing to decide.
    if (commitEarlyDenyReason) {
      skip("early_deny");
      await cleanupStickyDiskWithoutCommit(
        exposeId,
        stickyDiskKey,
        `commit denied for this job (${commitEarlyDenyReason}); changes to the sticky disk are discarded`,
      );
      return;
    }

    if (commitIntent === CommitIntent.IF_MISSING && wasFormatted !== "true") {
      skip("if_missing_existing");
      await cleanupStickyDiskWithoutCommit(
        exposeId,
        stickyDiskKey,
        "commit mode is 'if-missing' and a snapshot already existed at mount time (disk was not freshly formatted)",
      );
      return;
    }

    if (commitIntent === CommitIntent.ON_CHANGE) {
      const verdict = evaluateOnChangeCommit(
        initialUsageBytesStr,
        fsDiskUsageBytes,
      );
      core.info(verdict.summary);
      if (!verdict.commit) {
        skip("on_change_unchanged");
        await cleanupStickyDiskWithoutCommit(
          exposeId,
          stickyDiskKey,
          "commit mode is 'on-change' and the filesystem did not change",
        );
        return;
      }
    }

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
        skip("step_check_error");
        await cleanupStickyDiskWithoutCommit(
          exposeId,
          stickyDiskKey,
          "unable to determine whether previous steps failed",
        );
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
        skip("prior_step_failure");
        await cleanupStickyDiskWithoutCommit(
          exposeId,
          stickyDiskKey,
          `${failureCheck.failedCount} previous step(s) failed or were cancelled`,
        );
      } else {
        // No failures detected
        core.info(
          "No previous step failures detected, requesting sticky disk commit",
        );
        await commitStickydisk(exposeId, stickyDiskKey, fsDiskUsageBytes);
      }
    } else {
      core.warning(
        "Skipping sticky disk commit due to sticky disk error during setup",
      );
      skip("setup_error");
      await cleanupStickyDiskWithoutCommit(
        exposeId,
        stickyDiskKey,
        "the sticky disk failed during setup",
      );
    }
  } catch (error) {
    skip("post_error");
    if (error instanceof Error) {
      core.warning(
        `Failed to cleanup and commit sticky disk at ${stickyDiskPath}: ${error}`,
      );
    }
  } finally {
    await sendMountReport(report);
  }
}

run();
