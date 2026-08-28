import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { shellQuote } from "./path";

const execAsync = promisify(exec);

// Subdirectories of the sticky disk mount that hold the Go caches when
// go-caching is enabled. GOCACHE and GOMODCACHE must be distinct directories,
// so both live side by side on a single sticky disk.
export const GO_BUILD_CACHE_SUBDIR = "go-build";
export const GO_MOD_CACHE_SUBDIR = "go-mod";

export const DEFAULT_GO_BUILD_CACHE_LIMIT_GB = 50;
export const DEFAULT_GO_MOD_CACHE_LIMIT_GB = 15;

export function parseCacheLimitGb(
  value: string,
  defaultGb: number,
): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return defaultGb;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  // 0 disables the size limit.
  return parsed;
}

export function goBuildCachePath(stickyDiskPath: string): string {
  return path.join(stickyDiskPath, GO_BUILD_CACHE_SUBDIR);
}

export function goModCachePath(stickyDiskPath: string): string {
  return path.join(stickyDiskPath, GO_MOD_CACHE_SUBDIR);
}

// Creates the Go cache directories on the sticky disk and points GOCACHE and
// GOMODCACHE at them for all subsequent steps in the job.
export async function setupGoCaches(stickyDiskPath: string): Promise<void> {
  const buildCache = goBuildCachePath(stickyDiskPath);
  const modCache = goModCachePath(stickyDiskPath);

  await execAsync(`mkdir -p ${shellQuote(buildCache)} ${shellQuote(modCache)}`);

  core.exportVariable("GOCACHE", buildCache);
  core.exportVariable("GOMODCACHE", modCache);
  core.info(`Go caching enabled: GOCACHE=${buildCache} GOMODCACHE=${modCache}`);
}

async function dirSizeBytes(dir: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync(`du -sB1 ${shellQuote(dir)} | cut -f1`);
    const size = parseInt(stdout.trim(), 10);
    return isNaN(size) ? null : size;
  } catch (error) {
    core.debug(
      `Could not measure size of ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function wipeDir(dir: string): Promise<void> {
  // The Go module cache is written with read-only permissions, so a plain
  // rm -rf as the runner user fails on it. Remove with sudo and recreate the
  // directory owned by the runner user.
  await execAsync(`sudo rm -rf ${shellQuote(dir)}`);
  await execAsync(`mkdir -p ${shellQuote(dir)}`);
}

const FIND_MAX_BUFFER_BYTES = 1024 * 1024 * 1024;

// Evicts least-recently-used entries from a GOCACHE directory until it fits
// within limitBytes. The go tool bumps a cache entry file's mtime when the
// entry is used (at most once per hour), so file mtime is a usage signal, and
// deleting individual entry files is safe: go treats a missing entry as a
// cache miss and rebuilds it. Cache file names are hashes, so paths never
// contain newlines.
async function trimBuildCacheLru(
  dir: string,
  limitBytes: number,
  sizeBytes: number,
): Promise<void> {
  const { stdout } = await execAsync(
    `find ${shellQuote(dir)} -type f -printf '%T@\\t%s\\t%p\\n' | sort -n`,
    { maxBuffer: FIND_MAX_BUFFER_BYTES },
  );

  let bytesToFree = sizeBytes - limitBytes;
  const toDelete: string[] = [];
  for (const line of stdout.split("\n")) {
    if (bytesToFree <= 0) {
      break;
    }
    if (!line) {
      continue;
    }
    const [, sizeStr, ...pathParts] = line.split("\t");
    const fileSize = parseInt(sizeStr, 10);
    const filePath = pathParts.join("\t");
    if (isNaN(fileSize) || !filePath) {
      continue;
    }
    toDelete.push(filePath);
    bytesToFree -= fileSize;
  }

  if (toDelete.length === 0) {
    return;
  }

  const listFile = path.join(
    os.tmpdir(),
    `stickydisk-gocache-trim-${Date.now()}`,
  );
  await fs.writeFile(listFile, toDelete.join("\n"));
  try {
    await execAsync(`xargs -a ${shellQuote(listFile)} -d '\\n' rm -f --`, {
      maxBuffer: FIND_MAX_BUFFER_BYTES,
    });
  } finally {
    await fs.rm(listFile, { force: true });
  }
  core.info(
    `Evicted ${toDelete.length} least-recently-used build cache entries`,
  );
}

// Trims the Go caches so the committed snapshot stays bounded. A limit of 0
// disables trimming for that cache. Must run while the sticky disk is still
// mounted.
//
// GOCACHE is trimmed LRU per entry file (see trimBuildCacheLru). GOMODCACHE
// is wiped entirely when over its limit: module cache entries are immutable
// and their mtimes reflect download time rather than usage, and deleting
// individual files out of an extracted module directory would corrupt it.
export async function trimGoCaches(
  stickyDiskPath: string,
  buildLimitGb: number,
  modLimitGb: number,
): Promise<void> {
  const caches = [
    {
      name: "GOCACHE",
      dir: goBuildCachePath(stickyDiskPath),
      limitGb: buildLimitGb,
      trim: trimBuildCacheLru,
      action: "evicting least-recently-used entries",
    },
    {
      name: "GOMODCACHE",
      dir: goModCachePath(stickyDiskPath),
      limitGb: modLimitGb,
      trim: (dir: string) => wipeDir(dir),
      action: "wiping it",
    },
  ];

  for (const { name, dir, limitGb, trim, action } of caches) {
    if (limitGb <= 0) {
      core.debug(`${name} size limit disabled, skipping trim`);
      continue;
    }
    const sizeBytes = await dirSizeBytes(dir);
    if (sizeBytes === null) {
      continue;
    }
    const limitBytes = limitGb * (1 << 30);
    const sizeGb = (sizeBytes / (1 << 30)).toFixed(2);
    if (sizeBytes > limitBytes) {
      core.info(
        `${name} at ${dir} is ${sizeGb} GiB, over the ${limitGb} GiB limit; ${action} before commit`,
      );
      try {
        await trim(dir, limitBytes, sizeBytes);
      } catch (error) {
        core.warning(
          `Failed to trim ${name} at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      core.info(
        `${name} at ${dir} is ${sizeGb} GiB, within the ${limitGb} GiB limit`,
      );
    }
  }
}
