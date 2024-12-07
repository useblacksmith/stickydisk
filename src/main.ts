import { getInput, saveState } from "@actions/core";
import * as core from '@actions/core';
import { promisify } from 'util';
import { exec } from 'child_process';
import { createStickyDiskClient } from './utils';

const execAsync = promisify(exec);

async function getStickyDisk(stickyDiskKey: string, options?: {signal?: AbortSignal}): Promise<{expose_id: string; device: string}> {
  const client = createStickyDiskClient();
  
  core.debug(`Getting sticky disk for ${stickyDiskKey}`);
  const response = await client.getStickyDisk({
    stickyDiskKey: stickyDiskKey,
    region: process.env.BLACKSMITH_REGION || 'eu-central',
    installationModelId: process.env.BLACKSMITH_INSTALLATION_MODEL_ID || '',
    vmId: process.env.VM_ID || '',
    stickyDiskType: 'stickydisk',
    stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN,
    repoName: process.env.GITHUB_REPO_NAME || ''
  }, {
    signal: options?.signal,
  });

  return {
    expose_id: response.exposeId,
    device: response.diskIdentifier
  };
}

async function maybeFormatBlockDevice(device: string): Promise<string> {
  try {
    // Check if device is formatted with ext4
    try {
      const {stdout} = await execAsync(`sudo blkid -o value -s TYPE ${device}`);
      if (stdout.trim() === 'ext4') {
        core.debug(`Device ${device} is already formatted with ext4`);
        try {
          // Run resize2fs to ensure filesystem uses full block device
          await execAsync(`sudo resize2fs -f ${device}`);
          core.debug(`Resized ext4 filesystem on ${device}`);
        } catch (error) {
          if (error instanceof Error) {
            core.warning(`Error resizing ext4 filesystem on ${device}: ${error}`);
          }
        }
        return device;
      }
    } catch {
      // blkid returns non-zero if no filesystem found, which is fine
      core.debug(`No filesystem found on ${device}, will format it`);
    }

    // Format device with ext4
    core.debug(`Formatting device ${device} with ext4`);
    await execAsync(`sudo mkfs.ext4 -m0 -Enodiscard,lazy_itable_init=1,lazy_journal_init=1 -F ${device}`);
    core.debug(`Successfully formatted ${device} with ext4`);
    return device;
  } catch (error) {
    if (error instanceof Error) {
      core.error(`Failed to format device ${device}: ${error}`);
    }
    throw error;
  }
}

async function mountStickyDisk(stickyDiskKey: string, stickyDiskPath: string, signal: AbortSignal, controller: AbortController): Promise<{device: string, exposeId: string}> {
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  const stickyDiskResponse = await getStickyDisk(stickyDiskKey, {signal});
  const device = stickyDiskResponse.device;
  const exposeId = stickyDiskResponse.expose_id;
  clearTimeout(timeoutId);
  await maybeFormatBlockDevice(device);
  await execAsync(`sudo mkdir -p ${stickyDiskPath}`);
  await execAsync(`sudo mount ${device} ${stickyDiskPath}`);
  core.debug(`${device} has been mounted to ${stickyDiskPath} with expose ID ${exposeId}`);
  return {device, exposeId};
}

async function run(): Promise<void> {
  let stickyDiskError: Error | undefined;
  let exposeId: string | undefined;
  let device = '';
  const stickyDiskKey = getInput("key");
  const stickyDiskPath = getInput("path");
  
  // Save these values to GitHub Actions state
  saveState('STICKYDISK_PATH', stickyDiskPath);
  saveState('STICKYDISK_KEY', stickyDiskKey);
  
  core.info(`Mounting sticky disk at ${stickyDiskPath} with key ${stickyDiskKey}`);
  
  try {
    const controller = new AbortController();

    try {
      ({device, exposeId} = await mountStickyDisk(stickyDiskKey, stickyDiskPath, controller.signal, controller));
      saveState('STICKYDISK_EXPOSE_ID', exposeId);
      core.debug(`Sticky disk mounted to ${device}, expose ID: ${exposeId}`);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        core.warning('Request to get sticky disk timed out');
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof Error) {
      core.warning(`Error getting sticky disk: ${error}`);
      stickyDiskError = error;
      saveState('STICKYDISK_ERROR', 'true');
    }
  }

  if (stickyDiskError) {
    core.setFailed(`Error getting sticky disk: ${stickyDiskError}`);
  }
}

run();
