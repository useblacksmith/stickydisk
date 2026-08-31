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

export class GoCacheManager {
  readonly buildCachePath: string;
  readonly modCachePath: string;
  private readonly buildCacheLimitBytes: number;
  private readonly buildCacheMaxAgeMs: number;
  private readonly modCacheLimitBytes: number;
  private readonly sudo: boolean;

  constructor(
    stickyDiskPath: string,
    {
      buildCacheLimitBytes = 50 * (1 << 30),
      buildCacheMaxAgeMs = 7 * 86400 * 1000,
      modCacheLimitBytes = 15 * (1 << 30),
      sudo = true,
    }: {
      buildCacheLimitBytes?: number;
      buildCacheMaxAgeMs?: number;
      modCacheLimitBytes?: number;
      /** Wipe the mod cache with sudo (its extracted modules are read-only). */
      sudo?: boolean;
    } = {},
  ) {
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

  /** Trims over-limit Go caches. Returns true if anything was removed. */
  async trim(): Promise<boolean> {
    const [buildTrimmed, modTrimmed] = await Promise.all([
      this.trimBuildCache(),
      this.trimModCache(),
    ]);
    return buildTrimmed || modTrimmed;
  }

  /**
   * Evicts GOCACHE entry files unused for more than the max age, then
   * LRU-evicts until the cache fits in the limit (go bumps an entry's mtime
   * on use; a missing entry is just a cache miss). Returns true if anything
   * was deleted.
   */
  private async trimBuildCache(): Promise<boolean> {
    const dir = this.buildCachePath;
    let files: CacheFile[];
    try {
      files = await scanCache(dir);
    } catch (error) {
      core.debug(
        `Could not scan GOCACHE at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    const cutoffMs = Date.now() - this.buildCacheMaxAgeMs;
    const stale: CacheFile[] = [];
    const fresh: CacheFile[] = [];
    for (const file of files) {
      (file.mtimeMs < cutoffMs ? stale : fresh).push(file);
    }

    let trimmed = false;
    if (stale.length > 0) {
      try {
        await pMap(stale, (f) => fs.rm(f.path, { force: true }), {
          concurrency: IO_CONCURRENCY,
        });
        trimmed = true;
        core.info(
          `Evicted ${stale.length} build cache entries unused for more than ${this.buildCacheMaxAgeMs / (86400 * 1000)} days`,
        );
      } catch (error) {
        core.warning(
          `Failed to evict stale entries from GOCACHE at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
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
        `GOCACHE at ${dir} is ${toGb(sizeBytes)} GiB, within the ${toGb(limitBytes)} GiB limit`,
      );
      return trimmed;
    }

    core.info(
      `GOCACHE at ${dir} is ${toGb(sizeBytes)} GiB, over the ${toGb(limitBytes)} GiB limit; evicting least-recently-used entries before commit`,
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
      await pMap(toDelete, (f) => fs.rm(f.path, { force: true }), {
        concurrency: IO_CONCURRENCY,
      });
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
  private async trimModCache(): Promise<boolean> {
    const dir = this.modCachePath;
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

    const limitBytes = this.modCacheLimitBytes;
    if (sizeBytes <= limitBytes) {
      core.info(
        `GOMODCACHE at ${dir} is ${toGb(sizeBytes)} GiB, within the ${toGb(limitBytes)} GiB limit`,
      );
      return false;
    }

    core.info(
      `GOMODCACHE at ${dir} is ${toGb(sizeBytes)} GiB, over the ${toGb(limitBytes)} GiB limit; wiping it before commit`,
    );
    try {
      await execAsync(`${this.sudo ? "sudo " : ""}rm -rf ${shellQuote(dir)}`);
      await fs.mkdir(dir, { recursive: true });
      return true;
    } catch (error) {
      core.warning(
        `Failed to wipe GOMODCACHE at ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
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
