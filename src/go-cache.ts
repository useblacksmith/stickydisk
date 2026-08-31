import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { shellQuote } from "./path";

const execAsync = promisify(exec);

export const GO_BUILD_CACHE_SUBDIR = "go/build";
export const GO_MOD_CACHE_SUBDIR = "go/mod";

export const GO_BUILD_CACHE_LIMIT_GB = 50;
export const GO_MOD_CACHE_LIMIT_GB = 15;

export const GO_BUILD_CACHE_MAX_AGE_DAYS = 7;

/**
 * In-flight async fs ops. Async fs calls execute on the libuv threadpool
 * (sized 16 in uv-threadpool.ts), so this only needs to be comfortably above
 * that to keep every thread fed; 64 is the value the cache-trim benchmarks
 * on real runner sticky disks were measured with.
 */
const IO_CONCURRENCY = 64;

export function goBuildCachePath(stickyDiskPath: string): string {
  return path.join(stickyDiskPath, GO_BUILD_CACHE_SUBDIR);
}

export function goModCachePath(stickyDiskPath: string): string {
  return path.join(stickyDiskPath, GO_MOD_CACHE_SUBDIR);
}

export async function setupGoCaches(stickyDiskPath: string): Promise<void> {
  const buildCache = goBuildCachePath(stickyDiskPath);
  const modCache = goModCachePath(stickyDiskPath);

  await Promise.all([
    fs.mkdir(buildCache, { recursive: true }),
    fs.mkdir(modCache, { recursive: true }),
  ]);

  core.exportVariable("GOCACHE", buildCache);
  core.exportVariable("GOMODCACHE", modCache);
  core.info(`Go caching enabled: GOCACHE=${buildCache} GOMODCACHE=${modCache}`);
}

interface CacheFile {
  path: string;
  mtimeMs: number;
  // Disk usage (st_blocks), not apparent size, to match the on-disk limit.
  sizeBytes: number;
}

async function mapPool<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(IO_CONCURRENCY, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) {
          break;
        }
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Walks dir once and stats every file with concurrent I/O. Files that vanish
 * mid-scan are skipped.
 */
async function scanCache(dir: string): Promise<CacheFile[]> {
  const filePaths: string[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const batch = pending.splice(0, IO_CONCURRENCY);
    await Promise.all(
      batch.map(async (d) => {
        const entries = await fs.readdir(d, { withFileTypes: true });
        for (const entry of entries) {
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) {
            pending.push(p);
          } else if (entry.isFile()) {
            filePaths.push(p);
          }
        }
      }),
    );
  }

  const stats = await mapPool(filePaths, (f) => fs.stat(f).catch(() => null));
  const files: CacheFile[] = [];
  for (let i = 0; i < filePaths.length; i++) {
    const stat = stats[i];
    if (stat) {
      files.push({
        path: filePaths[i],
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.blocks * 512,
      });
    }
  }
  return files;
}

function toGb(bytes: number): string {
  return (bytes / (1 << 30)).toFixed(2);
}

/**
 * Evicts GOCACHE entry files unused for more than GO_BUILD_CACHE_MAX_AGE_DAYS,
 * then LRU-evicts until the cache fits in the limit (go bumps an entry's
 * mtime on use; a missing entry is just a cache miss). Returns true if
 * anything was deleted.
 */
async function trimBuildCache(dir: string): Promise<boolean> {
  let files: CacheFile[];
  try {
    files = await scanCache(dir);
  } catch (error) {
    core.debug(
      `Could not scan GOCACHE at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }

  const cutoffMs = Date.now() - GO_BUILD_CACHE_MAX_AGE_DAYS * 86400 * 1000;
  const stale: CacheFile[] = [];
  const fresh: CacheFile[] = [];
  for (const file of files) {
    (file.mtimeMs < cutoffMs ? stale : fresh).push(file);
  }

  let trimmed = false;
  if (stale.length > 0) {
    try {
      await mapPool(stale, (f) => fs.rm(f.path, { force: true }));
      trimmed = true;
      core.info(
        `Evicted ${stale.length} build cache entries unused for more than ${GO_BUILD_CACHE_MAX_AGE_DAYS} days`,
      );
    } catch (error) {
      core.warning(
        `Failed to evict stale entries from GOCACHE at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const limitBytes = GO_BUILD_CACHE_LIMIT_GB * (1 << 30);
  let sizeBytes = 0;
  for (const file of fresh) {
    sizeBytes += file.sizeBytes;
  }
  if (sizeBytes <= limitBytes) {
    core.info(
      `GOCACHE at ${dir} is ${toGb(sizeBytes)} GiB, within the ${GO_BUILD_CACHE_LIMIT_GB} GiB limit`,
    );
    return trimmed;
  }

  core.info(
    `GOCACHE at ${dir} is ${toGb(sizeBytes)} GiB, over the ${GO_BUILD_CACHE_LIMIT_GB} GiB limit; evicting least-recently-used entries before commit`,
  );
  try {
    fresh.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toDelete: CacheFile[] = [];
    for (const file of fresh) {
      if (sizeBytes <= limitBytes) {
        break;
      }
      toDelete.push(file);
      sizeBytes -= file.sizeBytes;
    }
    await mapPool(toDelete, (f) => fs.rm(f.path, { force: true }));
    core.info(
      `Evicted ${toDelete.length} least-recently-used build cache entries`,
    );
    return true;
  } catch (error) {
    core.warning(
      `Failed to trim GOCACHE at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return trimmed;
  }
}

/**
 * Wipes GOMODCACHE if it exceeds its limit. It is wiped rather than
 * LRU-trimmed because partial deletion corrupts extracted modules. Returns
 * true if it was wiped.
 */
async function trimModCache(dir: string): Promise<boolean> {
  let sizeBytes: number;
  try {
    const files = await scanCache(dir);
    sizeBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  } catch (error) {
    core.debug(
      `Could not scan GOMODCACHE at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }

  const limitBytes = GO_MOD_CACHE_LIMIT_GB * (1 << 30);
  if (sizeBytes <= limitBytes) {
    core.info(
      `GOMODCACHE at ${dir} is ${toGb(sizeBytes)} GiB, within the ${GO_MOD_CACHE_LIMIT_GB} GiB limit`,
    );
    return false;
  }

  core.info(
    `GOMODCACHE at ${dir} is ${toGb(sizeBytes)} GiB, over the ${GO_MOD_CACHE_LIMIT_GB} GiB limit; wiping it before commit`,
  );
  try {
    // sudo because the Go module cache is written read-only.
    await execAsync(`sudo rm -rf ${shellQuote(dir)}`);
    await fs.mkdir(dir, { recursive: true });
    return true;
  } catch (error) {
    core.warning(
      `Failed to wipe GOMODCACHE at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Trims over-limit Go caches. Returns true if anything was removed. */
export async function trimGoCaches(stickyDiskPath: string): Promise<boolean> {
  const [buildTrimmed, modTrimmed] = await Promise.all([
    trimBuildCache(goBuildCachePath(stickyDiskPath)),
    trimModCache(goModCachePath(stickyDiskPath)),
  ]);
  return buildTrimmed || modTrimmed;
}
