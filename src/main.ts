import { getInput, saveState } from "@actions/core";
import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";
import * as path from "path";
import { createStickyDiskClient, getAgentEndpoint } from "./utils";
import { CommitIntent, commitIntentFromMode } from "./commit-intent";
import { ON_CHANGE_CRITERIA, formatBytes } from "./on-change";
import {
  getWorkspaceLocalParentToChown,
  normalizeMountPath,
  shellQuote,
} from "./path";

const execAsync = promisify(exec);

// stickyDiskTimeoutMs states the max amount of time this action will wait for the VM agent to
// expose the sticky disk from the storage agent, map it onto the host and then patch the drive
// into the VM.
const stickyDiskTimeoutMs = 45000;

async function getStickyDisk(
  stickyDiskKey: string,
  commitIntent: CommitIntent,
  options?: { signal?: AbortSignal },
): Promise<{
  expose_id: string;
  device: string;
  // Non-empty when the host already knows this job's commit will be denied
  // (e.g. branch protection) and its writes to the sticky disk discarded.
  commit_early_deny_reason: string;
}> {
  const client = createStickyDiskClient();

  core.debug(`Getting sticky disk for ${stickyDiskKey}`);
  const response = await client.getStickyDisk(
    {
      stickyDiskKey: stickyDiskKey,
      region: process.env.BLACKSMITH_REGION || "eu-central",
      installationModelId: process.env.BLACKSMITH_INSTALLATION_MODEL_ID || "",
      vmId: process.env.BLACKSMITH_VM_ID || "",
      stickyDiskType: "stickydisk",
      stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN,
      repoName: process.env.GITHUB_REPO_NAME || "",
      commitIntent,
    },
    {
      signal: options?.signal,
    },
  );

  return {
    expose_id: response.exposeId,
    device: response.diskIdentifier,
    commit_early_deny_reason: response.commitEarlyDeny
      ? response.commitEarlyDenyReason || "denied by host policy"
      : "",
  };
}

// The VM agent's sticky-disk response can arrive before the guest kernel has
// processed the virtio config-change interrupt that publishes the drive's real
// capacity (the drive is hot-attached/hydrated in place), so the device can
// transiently report a size of zero. Wait for a non-zero size before touching
// the device.
async function waitForNonZeroDeviceSize(
  device: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const { stdout } = await execAsync(`sudo blockdev --getsize64 ${device}`);
      const size = parseInt(stdout.trim(), 10);
      if (!isNaN(size) && size > 0) {
        return;
      }
    } catch {
      // Device node may not exist yet; keep polling until the deadline.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Device ${device} still reports zero size after ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function maybeFormatBlockDevice(
  device: string,
): Promise<{ device: string; wasFormatted: boolean }> {
  try {
    // Check if device is formatted with ext4
    try {
      // Need sudo for blkid as it requires root to read block device metadata
      const { stdout } = await execAsync(
        `sudo blkid -o value -s TYPE ${device}`,
      );
      if (stdout.trim() === "ext4") {
        core.debug(`Device ${device} is already formatted with ext4`);
        try {
          // Need sudo for resize2fs as it requires root to modify block device
          // This operation preserves existing filesystem ownership and permissions
          await execAsync(`sudo resize2fs -f ${device}`);
          core.debug(`Resized ext4 filesystem on ${device}`);
        } catch (error) {
          if (error instanceof Error) {
            core.warning(
              `Error resizing ext4 filesystem on ${device}: ${error}`,
            );
          }
        }
        return { device, wasFormatted: false };
      }
    } catch {
      // blkid returns non-zero if no filesystem found, which is fine
      core.debug(`No filesystem found on ${device}, will format it`);
    }

    // Format device with ext4, setting default ownership to current user.
    core.debug(`Formatting device ${device} with ext4`);
    // Need sudo for mkfs.ext4 as it requires root to format block device
    // -m0: Disable reserved blocks (all space available to non-root users)
    // root_owner=$(id -u):$(id -g): Sets filesystem root directory owner to current (runner) user
    // This ensures the filesystem is owned by runner user from the start
    await execAsync(
      `sudo mkfs.ext4 -m0 -E root_owner=$(id -u):$(id -g) -Enodiscard,lazy_itable_init=1,lazy_journal_init=1 -F ${device}`,
    );
    core.debug(`Successfully formatted ${device} with ext4`);

    // Remove lost+found directory to prevent permission issues.
    // mkfs.ext4 always creates lost+found with root:root 0700 permissions for fsck recovery.
    // This causes EACCES errors when tools (pnpm, yarn, npm, docker buildx) recursively scan
    // directories mounted from sticky disks (e.g., ./node_modules, ./build-cache).
    // For ephemeral CI cache filesystems, lost+found is unnecessary - corruption can be
    // resolved by rebuilding the cache. Removing it prevents unpredictable build failures.
    core.debug(`Removing lost+found directory from ${device}`);
    const tempMount = `/tmp/stickydisk-init-${Date.now()}`;
    try {
      await execAsync(`sudo mkdir -p ${tempMount}`);
      await execAsync(`sudo mount -o noinit_itable ${device} ${tempMount}`);
      await execAsync(`sudo rm -rf ${tempMount}/lost+found`);
      await execAsync(`sudo umount ${tempMount}`);
      await execAsync(`sudo rmdir ${tempMount}`);
      core.debug(`Removed lost+found directory from ${device}`);
    } catch (error) {
      core.warning(
        `Failed to remove lost+found directory: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Non-fatal - continue even if cleanup fails
    }

    return { device, wasFormatted: true };
  } catch (error) {
    if (error instanceof Error) {
      core.warning(`Failed to format device ${device}: ${error}`);
    }
    throw error;
  }
}

// Creates the mount point directory, keeping it (and any workspace-local
// parent) owned by the runner user. Parents are created without sudo first so
// that intermediate directories under $HOME (e.g. ~/.cache) stay writable by
// the runner; sudo is only needed for system directories like /nix or /mnt.
async function createMountPoint(stickyDiskPath: string): Promise<void> {
  const parentPath = path.dirname(stickyDiskPath);
  try {
    await execAsync(`mkdir -p ${shellQuote(parentPath)}`);
  } catch (error) {
    core.debug(
      `Could not create mount parent ${parentPath} as current user: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await execAsync(`sudo mkdir -p ${shellQuote(stickyDiskPath)}`);
  await execAsync(`sudo chown $(id -u):$(id -g) ${shellQuote(stickyDiskPath)}`);

  const workspaceParentPath = getWorkspaceLocalParentToChown(stickyDiskPath);
  if (workspaceParentPath) {
    // Nested workspace mounts such as .nx/cache need a writable parent so tools can recreate them.
    await execAsync(
      `sudo chown $(id -u):$(id -g) ${shellQuote(workspaceParentPath)}`,
    );
  }
}

// Guest-side setup timings, filled in as each phase completes so a failure
// midway still reports the phases that ran.
interface SetupTimings {
  formatMs: number;
  mountMs: number;
}

async function mountStickyDisk(
  stickyDiskKey: string,
  commitIntent: CommitIntent,
  stickyDiskPath: string,
  signal: AbortSignal,
  controller: AbortController,
  timings: SetupTimings,
): Promise<{
  device: string;
  exposeId: string;
  wasFormatted: boolean;
  commitEarlyDenyReason: string;
}> {
  const timeoutId = setTimeout(() => controller.abort(), stickyDiskTimeoutMs);
  let stickyDiskResponse: {
    expose_id: string;
    device: string;
    commit_early_deny_reason: string;
  };
  try {
    stickyDiskResponse = await getStickyDisk(stickyDiskKey, commitIntent, {
      signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  const device = stickyDiskResponse.device;
  const exposeId = stickyDiskResponse.expose_id;
  // Saved before format/mount so the post step can report a guest-side
  // failure against the disk the host exposed.
  saveState("STICKYDISK_EXPOSE_ID", exposeId);
  const commitEarlyDenyReason = stickyDiskResponse.commit_early_deny_reason;
  if (commitEarlyDenyReason !== "") {
    core.notice(
      `Sticky disk changes will not be committed for this job (${commitEarlyDenyReason}). The sticky disk is used as-is and any changes to it are discarded.`,
    );
  }
  await waitForNonZeroDeviceSize(device, 10000);
  const formatStart = Date.now();
  const { wasFormatted } = await maybeFormatBlockDevice(device);
  timings.formatMs = Date.now() - formatStart;

  await createMountPoint(stickyDiskPath);

  const mountStart = Date.now();
  // noinit_itable stops the background zeroing of a non-trivial portion of
  // the device (uninitialized inode tables), which is unnecessary here.
  await execAsync(
    `sudo mount -o noinit_itable ${shellQuote(device)} ${shellQuote(stickyDiskPath)}`,
  );

  // After mounting, ensure the mounted filesystem is owned by runner user
  // This is important because the mount operation might change ownership
  await execAsync(`sudo chown $(id -u):$(id -g) ${shellQuote(stickyDiskPath)}`);
  timings.mountMs = Date.now() - mountStart;

  core.debug(
    `${device} has been mounted to ${stickyDiskPath} with expose ID ${exposeId}`,
  );
  return { device, exposeId, wasFormatted, commitEarlyDenyReason };
}

async function ensureFallbackDirectory(stickyDiskPath: string): Promise<void> {
  try {
    await createMountPoint(stickyDiskPath);

    core.info(
      `Sticky disk unavailable; created empty directory at ${stickyDiskPath} so subsequent steps see a cache miss instead of a missing path`,
    );
  } catch (error) {
    core.warning(
      `Failed to create fallback directory at ${stickyDiskPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getInitialDiskUsage(
  stickyDiskPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `df -B1 --output=used ${shellQuote(stickyDiskPath)} | tail -n1`,
    );
    const value = stdout.trim();
    if (value && !isNaN(parseInt(value, 10))) {
      return value;
    }
    core.debug(`Invalid initial disk usage value from df: "${value}"`);
  } catch (error) {
    core.debug(
      `Could not get initial disk usage: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return null;
}

async function run(): Promise<void> {
  let stickyDiskError: Error | undefined;
  let exposeId: string | undefined;
  let device = "";
  let wasFormatted = false;
  let commitEarlyDenyReason = "";
  const timings: SetupTimings = { formatMs: 0, mountMs: 0 };
  const stickyDiskKey = getInput("key");
  const stickyDiskPath = normalizeMountPath(getInput("path"));
  const commitMode = getInput("commit") || "true";
  const commitIntent = commitIntentFromMode(commitMode);

  // Save these values to GitHub Actions state
  saveState("STICKYDISK_PATH", stickyDiskPath);
  saveState("STICKYDISK_KEY", stickyDiskKey);
  saveState("STICKYDISK_COMMIT_MODE", commitMode);

  if (!getAgentEndpoint()) {
    core.warning(
      `BLACKSMITH_AGENT_ADDR or BLACKSMITH_STICKY_DISK_GRPC_PORT is not set; sticky disks are unavailable on this runner. Creating ${stickyDiskPath} as a plain directory instead (contents will not persist across runs).`,
    );
    await ensureFallbackDirectory(stickyDiskPath);
    return;
  }

  core.info(
    `Mounting sticky disk at ${stickyDiskPath} with key ${stickyDiskKey} (commit: ${commitMode})`,
  );

  try {
    const controller = new AbortController();

    try {
      ({ device, exposeId, wasFormatted, commitEarlyDenyReason } =
        await mountStickyDisk(
          stickyDiskKey,
          commitIntent,
          stickyDiskPath,
          controller.signal,
          controller,
          timings,
        ));
      saveState("STICKYDISK_WAS_FORMATTED", wasFormatted ? "true" : "false");
      saveState("STICKYDISK_COMMIT_EARLY_DENY_REASON", commitEarlyDenyReason);
      core.debug(
        `Sticky disk mounted to ${device}, expose ID: ${exposeId}, freshly formatted: ${wasFormatted}`,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        core.warning("Request to get sticky disk timed out");
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof Error) {
      stickyDiskError = error;
      saveState("STICKYDISK_ERROR", "true");
    }
  }

  saveState("STICKYDISK_FORMAT_MS", String(timings.formatMs));
  saveState("STICKYDISK_MOUNT_MS", String(timings.mountMs));

  if (stickyDiskError) {
    core.warning(`Error getting sticky disk: ${stickyDiskError}`);
    // Degrade gracefully: make sure the requested path exists as an empty,
    // writable directory so downstream steps behave as if this were a fresh
    // sticky disk (a cache miss) rather than failing on a missing path.
    await ensureFallbackDirectory(stickyDiskPath);
  }

  // Record initial disk usage after mount for on-change detection. Skipped
  // when the host already denied the commit: the post step will not commit
  // regardless of whether the filesystem changed.
  if (
    !stickyDiskError &&
    commitEarlyDenyReason === "" &&
    commitIntent === CommitIntent.ON_CHANGE
  ) {
    const initialUsage = await getInitialDiskUsage(stickyDiskPath);
    if (initialUsage) {
      saveState("STICKYDISK_INITIAL_USAGE_BYTES", initialUsage);
      core.info(`on-change: ${ON_CHANGE_CRITERIA}`);
      core.debug(
        `on-change: usage at mount is ${formatBytes(parseInt(initialUsage, 10))}`,
      );
    } else {
      core.warning(
        `on-change: could not measure usage at mount; the post step will request a commit`,
      );
    }
  }
}

run();
