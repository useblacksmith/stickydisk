import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { shellQuote } from "./path";

const execAsync = promisify(exec);

export const GO_BUILD_CACHE_SUBDIR = "go/build";
export const GO_MOD_CACHE_SUBDIR = "go/mod";

export const GO_BUILD_CACHE_LIMIT_GB = 50;
export const GO_MOD_CACHE_LIMIT_GB = 15;

export const GO_BUILD_CACHE_MAX_AGE_DAYS = 7;

export function goBuildCachePath(stickyDiskPath: string): string {
  return path.join(stickyDiskPath, GO_BUILD_CACHE_SUBDIR);
}

export function goModCachePath(stickyDiskPath: string): string {
  return path.join(stickyDiskPath, GO_MOD_CACHE_SUBDIR);
}

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
  // sudo because the Go module cache is written read-only.
  await execAsync(`sudo rm -rf ${shellQuote(dir)}`);
  await execAsync(`mkdir -p ${shellQuote(dir)}`);
}

const FIND_MAX_BUFFER_BYTES = 1024 * 1024 * 1024;

/**
 * Deletes GOCACHE entry files not used in more than
 * GO_BUILD_CACHE_MAX_AGE_DAYS (go bumps an entry's mtime on use).
 */
async function evictStaleBuildCacheEntries(dir: string): Promise<boolean> {
  const { stdout } = await execAsync(
    `find ${shellQuote(dir)} -type f -mtime +${GO_BUILD_CACHE_MAX_AGE_DAYS} -print -delete | wc -l`,
    { maxBuffer: FIND_MAX_BUFFER_BYTES },
  );
  const count = parseInt(stdout.trim(), 10);
  if (!count) {
    return false;
  }
  core.info(
    `Evicted ${count} build cache entries unused for more than ${GO_BUILD_CACHE_MAX_AGE_DAYS} days`,
  );
  return true;
}

/**
 * LRU-evicts GOCACHE entry files (go bumps an entry's mtime on use; a
 * missing entry is just a cache miss) until the cache fits in limitBytes.
 */
async function trimBuildCacheLru(
  dir: string,
  limitBytes: number,
  sizeBytes: number,
): Promise<boolean> {
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
    return false;
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
  return true;
}

/**
 * Trims over-limit Go caches. GOMODCACHE is wiped rather than LRU-trimmed
 * (partial deletion corrupts extracted modules). Returns true if anything
 * was removed.
 */
export async function trimGoCaches(stickyDiskPath: string): Promise<boolean> {
  const caches = [
    {
      name: "GOCACHE",
      dir: goBuildCachePath(stickyDiskPath),
      limitGb: GO_BUILD_CACHE_LIMIT_GB,
      preTrim: evictStaleBuildCacheEntries,
      trim: trimBuildCacheLru,
      action: "evicting least-recently-used entries",
    },
    {
      name: "GOMODCACHE",
      dir: goModCachePath(stickyDiskPath),
      limitGb: GO_MOD_CACHE_LIMIT_GB,
      preTrim: undefined,
      trim: async (dir: string): Promise<boolean> => {
        await wipeDir(dir);
        return true;
      },
      action: "wiping it",
    },
  ] satisfies {
    name: string;
    dir: string;
    limitGb: number;
    preTrim: ((dir: string) => Promise<boolean>) | undefined;
    trim: (
      dir: string,
      limitBytes: number,
      sizeBytes: number,
    ) => Promise<boolean>;
    action: string;
  }[];

  const results = await Promise.all(
    caches.map(async ({ name, dir, limitGb, preTrim, trim, action }) => {
      let trimmed = false;
      if (preTrim) {
        try {
          trimmed = await preTrim(dir);
        } catch (error) {
          core.warning(
            `Failed to evict stale entries from ${name} at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const sizeBytes = await dirSizeBytes(dir);
      if (sizeBytes === null) {
        return trimmed;
      }
      const limitBytes = limitGb * (1 << 30);
      const sizeGb = (sizeBytes / (1 << 30)).toFixed(2);
      if (sizeBytes <= limitBytes) {
        core.info(
          `${name} at ${dir} is ${sizeGb} GiB, within the ${limitGb} GiB limit`,
        );
        return trimmed;
      }
      core.info(
        `${name} at ${dir} is ${sizeGb} GiB, over the ${limitGb} GiB limit; ${action} before commit`,
      );
      try {
        return (await trim(dir, limitBytes, sizeBytes)) || trimmed;
      } catch (error) {
        core.warning(
          `Failed to trim ${name} at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return trimmed;
      }
    }),
  );

  return results.some(Boolean);
}
