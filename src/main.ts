import { getInput, saveState } from "@actions/core";
import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";
import * as path from "path";
import { createStickyDiskClient } from "./utils";
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
  options?: { signal?: AbortSignal },
): Promise<{ expose_id: string; device: string }> {
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
    },
    {
      signal: options?.signal,
    },
  );

  return {
    expose_id: response.exposeId,
    device: response.diskIdentifier,
  };
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
      await execAsync(`sudo mount ${device} ${tempMount}`);
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

async function mountStickyDisk(
  stickyDiskKey: string,
  stickyDiskPath: string,
  signal: AbortSignal,
  controller: AbortController,
): Promise<{ device: string; exposeId: string; wasFormatted: boolean }> {
  const timeoutId = setTimeout(() => controller.abort(), stickyDiskTimeoutMs);
  let stickyDiskResponse: { expose_id: string; device: string };
  try {
    stickyDiskResponse = await getStickyDisk(stickyDiskKey, { signal });
  } finally {
    clearTimeout(timeoutId);
  }
  const device = stickyDiskResponse.device;
  const exposeId = stickyDiskResponse.expose_id;
  const { wasFormatted } = await maybeFormatBlockDevice(device);
  const parentPath = path.dirname(stickyDiskPath);
  try {
    await execAsync(`mkdir -p ${shellQuote(parentPath)}`);
  } catch (error) {
    core.debug(
      `Could not create mount parent ${parentPath} as current user: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Create mount point with sudo (supports system directories like /nix, /mnt, etc.)
  // Then change ownership to runner user so it's accessible
  await execAsync(`sudo mkdir -p ${shellQuote(stickyDiskPath)}`);
  await execAsync(`sudo chown $(id -u):$(id -g) ${shellQuote(stickyDiskPath)}`);

  const workspaceParentPath = getWorkspaceLocalParentToChown(stickyDiskPath);
  if (workspaceParentPath) {
    // Nested workspace mounts such as .nx/cache need a writable parent so tools can recreate them.
    await execAsync(
      `sudo chown $(id -u):$(id -g) ${shellQuote(workspaceParentPath)}`,
    );
  }

  // Mount the device with default options
  await execAsync(
    `sudo mount ${shellQuote(device)} ${shellQuote(stickyDiskPath)}`,
  );

  // After mounting, ensure the mounted filesystem is owned by runner user
  // This is important because the mount operation might change ownership
  await execAsync(`sudo chown $(id -u):$(id -g) ${shellQuote(stickyDiskPath)}`);

  core.debug(
    `${device} has been mounted to ${stickyDiskPath} with expose ID ${exposeId}`,
  );
  return { device, exposeId, wasFormatted };
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
  const stickyDiskKey = getInput("key");
  const stickyDiskPath = normalizeMountPath(getInput("path"));
  const commitMode = getInput("commit") || "true";

  // Save these values to GitHub Actions state
  saveState("STICKYDISK_PATH", stickyDiskPath);
  saveState("STICKYDISK_KEY", stickyDiskKey);
  saveState("STICKYDISK_COMMIT_MODE", commitMode);

  core.info(
    `Mounting sticky disk at ${stickyDiskPath} with key ${stickyDiskKey} (commit: ${commitMode})`,
  );

  try {
    const controller = new AbortController();

    try {
      ({ device, exposeId, wasFormatted } = await mountStickyDisk(
        stickyDiskKey,
        stickyDiskPath,
        controller.signal,
        controller,
      ));
      saveState("STICKYDISK_EXPOSE_ID", exposeId);
      saveState("STICKYDISK_WAS_FORMATTED", wasFormatted ? "true" : "false");
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

  if (stickyDiskError) {
    core.warning(`Error getting sticky disk: ${stickyDiskError}`);
  }

  // Record initial disk usage after mount for on-change detection
  if (!stickyDiskError && commitMode === "on-change") {
    const initialUsage = await getInitialDiskUsage(stickyDiskPath);
    if (initialUsage) {
      saveState("STICKYDISK_INITIAL_USAGE_BYTES", initialUsage);
      core.debug(`Recorded initial disk usage: ${initialUsage} bytes`);
    }
  }
}

run();
