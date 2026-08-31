import * as core from "@actions/core";
import { promisify } from "util";
import { exec } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import pLimit from "p-limit";
import pMap from "p-map";
import { shellQuote } from "./path";

const execAsync = promisify(exec);

/**
 * In-flight async fs ops. Async fs calls execute on the libuv threadpool
 * (sized 16 in uv-threadpool.ts), so this only needs to be comfortably above
 * that to keep every thread fed; 64 is the value the benchmarks were measured
 * with (methodology and results:
 * https://github.com/useblacksmith/stickydisk/pull/75#issuecomment-5478135682).
 */
const IO_CONCURRENCY = 64;

interface CacheFile {
  path: string;
  mtimeMs: number;
  // Disk usage (st_blocks), not apparent size, to match the on-disk limit.
  sizeBytes: number;
}

export interface GoCacheOptions {
  stickyDiskPath: string;
  buildCacheLimitBytes?: number;
  buildCacheMaxAgeMs?: number;
  modCacheLimitBytes?: number;
  /** Wipe the mod cache with sudo (its extracted modules are read-only). */
  sudo?: boolean;
}

export class GoCacheManager {
  readonly buildCachePath: string;
  readonly modCachePath: string;
  private readonly buildCacheLimitBytes: number;
  private readonly buildCacheMaxAgeMs: number;
  private readonly modCacheLimitBytes: number;
  private readonly sudo: boolean;

  constructor({
    stickyDiskPath,
    buildCacheLimitBytes = 100 * (1 << 30), // 100 GiB
    buildCacheMaxAgeMs = 7 * 86400 * 1000, // 7 days
    modCacheLimitBytes = 15 * (1 << 30), // 15 GiB
    sudo = true,
  }: GoCacheOptions) {
    this.buildCachePath = path.join(stickyDiskPath, "go/build");
    this.modCachePath = path.join(stickyDiskPath, "go/mod");
    this.buildCacheLimitBytes = buildCacheLimitBytes;
    this.buildCacheMaxAgeMs = buildCacheMaxAgeMs;
    this.modCacheLimitBytes = modCacheLimitBytes;
    this.sudo = sudo;
  }

  async setup(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.buildCachePath, { recursive: true }),
      fs.mkdir(this.modCachePath, { recursive: true }),
    ]);

    core.exportVariable("GOCACHE", this.buildCachePath);
    core.exportVariable("GOMODCACHE", this.modCachePath);
    core.info(
      `Go caching enabled: GOCACHE=${this.buildCachePath} GOMODCACHE=${this.modCachePath}`,
    );
  }

  /** Trims over-limit Go caches. */
  async trim(): Promise<void> {
    await Promise.all([this.trimBuildCache(), this.trimModCache()]);
  }

  /**
   * Evicts GOCACHE entry files unused for more than the max age, then, if the
   * cache is over the limit, LRU-evicts down to half the limit (go bumps an
   * entry's mtime on use; a missing entry is just a cache miss).
   */
  private async trimBuildCache(): Promise<void> {
    const dir = this.buildCachePath;
    let files: CacheFile[];
    try {
      files = await scanCache(dir);
    } catch (error) {
      core.warning(
        `Could not scan GOCACHE at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const cutoffMs = Date.now() - this.buildCacheMaxAgeMs;
    const stale: CacheFile[] = [];
    const fresh: CacheFile[] = [];
    for (const file of files) {
      (file.mtimeMs < cutoffMs ? stale : fresh).push(file);
    }

    if (stale.length > 0) {
      const removed = await removeFiles(stale, dir);
      if (removed > 0) {
        core.info(
          `Evicted ${removed} build cache entries unused for more than ${this.buildCacheMaxAgeMs / (86400 * 1000)} days`,
        );
      }
    }

    const limitBytes = this.buildCacheLimitBytes;
    let sizeBytes = 0;
    for (const file of fresh) {
      sizeBytes += file.sizeBytes;
    }
    if (sizeBytes <= limitBytes) {
      core.info(
        `GOCACHE is ${toGb(sizeBytes)} GiB, within the ${toGb(limitBytes)} GiB limit`,
      );
      return;
    }

    // Trim to half the limit rather than just under it, so busy repos don't
    // hover at the threshold and re-trim (and re-commit) on every job.
    const targetBytes = limitBytes / 2;
    core.info(
      `GOCACHE is ${toGb(sizeBytes)} GiB, over the ${toGb(limitBytes)} GiB limit; trimming to ${toGb(targetBytes)} GiB`,
    );
    fresh.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toDelete: CacheFile[] = [];
    for (const file of fresh) {
      if (sizeBytes <= targetBytes) {
        break;
      }
      toDelete.push(file);
      sizeBytes -= file.sizeBytes;
    }
    const removed = await removeFiles(toDelete, dir);
    core.info(`Removed ${removed} old build cache entries`);
  }

  /**
   * Wipes GOMODCACHE if it exceeds its limit. It is wiped rather than
   * LRU-trimmed because partial deletion corrupts extracted modules.
   */
  private async trimModCache(): Promise<void> {
    const dir = this.modCachePath;
    let sizeBytes: number;
    try {
      const files = await scanCache(dir);
      sizeBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
    } catch (error) {
      core.warning(
        `Could not scan GOMODCACHE at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const limitBytes = this.modCacheLimitBytes;
    if (sizeBytes <= limitBytes) {
      core.info(
        `GOMODCACHE is ${toGb(sizeBytes)} GiB, within the ${toGb(limitBytes)} GiB limit`,
      );
      return;
    }

    core.info(
      `GOMODCACHE is ${toGb(sizeBytes)} GiB, over the ${toGb(limitBytes)} GiB limit; wiping cache`,
    );
    try {
      await execAsync(`${this.sudo ? "sudo " : ""}rm -rf ${shellQuote(dir)}`);
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      core.warning(
        `Failed to wipe GOMODCACHE at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Removes files individually rather than failing fast, so one undeletable
 * entry does not abort the trim. Returns the number removed.
 */
async function removeFiles(files: CacheFile[], dir: string): Promise<number> {
  let removed = 0;
  let failed = 0;
  let firstError: unknown = null;
  await pMap(
    files,
    async (file) => {
      try {
        await fs.rm(file.path, { force: true });
        removed++;
      } catch (error) {
        failed++;
        firstError ??= error;
      }
    },
    { concurrency: IO_CONCURRENCY },
  );
  if (failed > 0) {
    core.warning(
      `Failed to remove ${failed} of ${files.length} entries from GOCACHE at ${dir}: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
    );
  }
  return removed;
}

/**
 * Walks dir once and stats every file with concurrent I/O. Files that vanish
 * mid-scan are skipped.
 */
async function scanCache(dir: string): Promise<CacheFile[]> {
  const limit = pLimit(IO_CONCURRENCY);
  const filePaths: string[] = [];
  const walk = async (d: string): Promise<void> => {
    const entries = await limit(() => fs.readdir(d, { withFileTypes: true }));
    const subdirs: Promise<void>[] = [];
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(walk(p));
      } else if (entry.isFile()) {
        filePaths.push(p);
      }
    }
    await Promise.all(subdirs);
  };
  await walk(dir);

  const stats = await pMap(filePaths, (f) => fs.stat(f).catch(() => null), {
    concurrency: IO_CONCURRENCY,
  });
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
