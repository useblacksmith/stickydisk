import { getInput, saveState } from "@actions/core";
import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";
import { createStickyDiskClient } from "./utils";

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

async function maybeFormatBlockDevice(device: string): Promise<string> {
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
        return device;
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

    return device;
  } catch (error) {
    if (error instanceof Error) {
      core.warning(`Failed to format device ${device}: ${error}`);
    }
    throw error;
  }
}

async function checkAndPrepareWorkDir(
  internalMount: string,
): Promise<{ needsNewDisk: boolean }> {
  const workDir = `${internalMount}/work`;

  // Check if work/ directory already exists (new format disk)
  try {
    await execAsync(`sudo test -d ${workDir}`);
    core.debug(`work/ directory already exists, disk is in new format`);
    return { needsNewDisk: false };
  } catch {
    // work/ doesn't exist, check if there's old data
  }

  // Check if there are any files/directories at root (excluding lost+found)
  // This indicates an old-format sticky disk
  try {
    const { stdout } = await execAsync(
      `sudo find ${internalMount} -maxdepth 1 -mindepth 1 ! -name lost+found -print -quit`,
    );

    if (stdout.trim()) {
      // Old format disk detected - needs to be cleared
      core.warning(
        `Detected old sticky disk format (data at filesystem root). This disk needs to be cleared for the new format.`,
      );
      return { needsNewDisk: true };
    }

    // No old data, just create work/ directory
    core.debug(`No existing data found, creating fresh work/ directory`);
    await execAsync(`sudo mkdir -p ${workDir}`);
    return { needsNewDisk: false };
  } catch (error) {
    // Errors checking - create fresh work dir to be safe
    core.warning(
      `Error checking disk format: ${error instanceof Error ? error.message : String(error)}`,
    );
    core.debug(`Creating fresh work/ directory despite errors`);
    await execAsync(`sudo mkdir -p ${workDir}`);
    return { needsNewDisk: false };
  }
}

async function mountStickyDisk(
  stickyDiskKey: string,
  stickyDiskPath: string,
  signal: AbortSignal,
  controller: AbortController,
): Promise<{ device: string; exposeId: string; internalMount: string }> {
  const timeoutId = setTimeout(() => controller.abort(), stickyDiskTimeoutMs);
  const stickyDiskResponse = await getStickyDisk(stickyDiskKey, { signal });
  const device = stickyDiskResponse.device;
  const exposeId = stickyDiskResponse.expose_id;
  clearTimeout(timeoutId);
  await maybeFormatBlockDevice(device);

  // Create internal mount point to hide lost+found from user's view
  // This internal mount contains the full ext4 filesystem including lost+found
  const internalMount = `/mnt/stickydisk/${exposeId}`;
  await execAsync(`sudo mkdir -p ${internalMount}`);

  // Mount the device to the internal location
  await execAsync(`sudo mount ${device} ${internalMount}`);
  core.debug(`Mounted ${device} to internal location ${internalMount}`);

  // Check if this is an old-format disk that needs to be cleared
  const { needsNewDisk } = await checkAndPrepareWorkDir(internalMount);

  if (needsNewDisk) {
    core.warning(
      `Old sticky disk format detected (data at filesystem root, not in work/).`,
    );
    core.warning(
      `This disk is incompatible with the new bind-mount approach.`,
    );

    // TODO: Implement proper disk deletion and retry logic
    // The current approach of calling deleteStickyDisk + recursive mountStickyDisk
    // may not properly invalidate the cache on the storage backend.
    // Need to:
    // 1. Unmount the current disk
    // 2. Call the correct API to invalidate/delete the sticky disk
    // 3. Request a fresh disk (ensuring we don't get the same one back)
    //
    // For now, fail fast and let the user clear the cache manually
    throw new Error(
      `Incompatible sticky disk format detected. Please clear the sticky disk cache and try again.`,
    );
  }

  // Create a work subdirectory that will be exposed to the user
  // This keeps lost+found at the filesystem root, outside the user's tree
  const workDir = `${internalMount}/work`;
  // Set reasonable permissions for typical CI users
  await execAsync(`sudo chmod 0755 ${workDir}`);
  await execAsync(`sudo chown $(id -u):$(id -g) ${workDir}`);

  // Create the user's mount point with sudo (supports system directories like /nix, /mnt, etc.)
  await execAsync(`sudo mkdir -p ${stickyDiskPath}`);
  await execAsync(`sudo chown $(id -u):$(id -g) ${stickyDiskPath}`);

  // Bind-mount only the work subdirectory to the user's requested path
  // This exposes only the work/ subdirectory, hiding lost+found from scanners
  await execAsync(`sudo mount --bind ${workDir} ${stickyDiskPath}`);

  core.debug(
    `${device} has been mounted to ${stickyDiskPath} (via bind mount from ${workDir}) with expose ID ${exposeId}`,
  );
  return { device, exposeId, internalMount };
}

async function run(): Promise<void> {
  let stickyDiskError: Error | undefined;
  let exposeId: string | undefined;
  let device = "";
  let internalMount = "";
  const stickyDiskKey = getInput("key");
  const stickyDiskPath = getInput("path");

  // Save these values to GitHub Actions state
  saveState("STICKYDISK_PATH", stickyDiskPath);
  saveState("STICKYDISK_KEY", stickyDiskKey);

  core.info(
    `Mounting sticky disk at ${stickyDiskPath} with key ${stickyDiskKey}`,
  );

  try {
    const controller = new AbortController();

    try {
      ({ device, exposeId, internalMount } = await mountStickyDisk(
        stickyDiskKey,
        stickyDiskPath,
        controller.signal,
        controller,
      ));
      saveState("STICKYDISK_EXPOSE_ID", exposeId);
      saveState("STICKYDISK_INTERNAL_MOUNT", internalMount);
      core.debug(
        `Sticky disk mounted to ${device}, internal mount: ${internalMount}, expose ID: ${exposeId}`,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        core.warning("Request to get sticky disk timed out");
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof Error) {
      core.warning(`Error getting sticky disk: ${error}`);
      stickyDiskError = error;
      saveState("STICKYDISK_ERROR", "true");
    }
  }

  if (stickyDiskError) {
    core.warning(`Error getting sticky disk: ${stickyDiskError}`);
  }
}

run();
