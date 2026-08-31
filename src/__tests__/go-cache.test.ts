import { describe, expect, test, vi } from "vitest";
import { exec } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { GoCacheManager, GoCacheOptions } from "../go-cache";
import { shellQuote } from "../path";

const execAsync = promisify(exec);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const it = test.extend<{ h: TestHarness }>({
  h: async ({ onTestFinished }, use) => {
    await use(await TestHarness.new({ onTestFinished }));
  },
});

describe("GoCacheManager", () => {
  it("places both caches under the sticky disk mount", () => {
    const caches = new GoCacheManager("/mnt/go-cache");
    expect(caches.buildCachePath).toBe("/mnt/go-cache/go/build");
    expect(caches.modCachePath).toBe("/mnt/go-cache/go/mod");
  });

  describe("setup()", () => {
    it("creates dirs and exports GOCACHE/GOMODCACHE", async ({ h }) => {
      const envFile = path.join(h.tmp, "github.env");
      await fs.writeFile(envFile, "");
      vi.stubEnv("GITHUB_ENV", envFile);
      vi.stubEnv("GOCACHE", undefined);
      vi.stubEnv("GOMODCACHE", undefined);

      const caches = h.manager();
      await caches.setup();

      expect((await fs.stat(caches.buildCachePath)).isDirectory()).toBe(true);
      expect((await fs.stat(caches.modCachePath)).isDirectory()).toBe(true);
      expect(process.env.GOCACHE).toBe(caches.buildCachePath);
      expect(process.env.GOMODCACHE).toBe(caches.modCachePath);

      const exported = parseGithubEnv(await fs.readFile(envFile, "utf8"));
      expect(exported.GOCACHE).toBe(caches.buildCachePath);
      expect(exported.GOMODCACHE).toBe(caches.modCachePath);

      // Idempotent: a second setup preserves existing cache contents.
      const marker = await h.writeBuildFile("00/marker");
      await caches.setup();
      expect(await h.exists(marker)).toBe(true);
      expect(process.env.GOCACHE).toBe(caches.buildCachePath);
    });
  });

  describe("trim()", () => {
    describe("build cache", () => {
      it("keeps everything when under the limit", async ({ h }) => {
        const a = await h.writeBuildFile("00/a");
        const b = await h.writeBuildFile("01/b");

        await h.manager().trim();
        expect(await h.exists(a)).toBe(true);
        expect(await h.exists(b)).toBe(true);
      });

      it("evicts stale entries and keeps fresh ones", async ({ h }) => {
        const stale = await h.writeBuildFile("00/stale", { ageMs: 8 * DAY });
        const fresh = await h.writeBuildFile("01/fresh", { ageMs: 1 * DAY });

        await h.manager().trim();
        expect(await h.exists(stale)).toBe(false);
        expect(await h.exists(fresh)).toBe(true);
      });

      it("LRU-evicts down to half the limit when over it", async ({ h }) => {
        // All well within the max age, so only the size limit applies.
        const oldest = await h.writeBuildFile("00/oldest", { ageMs: 4 * HOUR });
        const older = await h.writeBuildFile("01/older", { ageMs: 3 * HOUR });
        const newer = await h.writeBuildFile("02/newer", { ageMs: 2 * HOUR });
        const newest = await h.writeBuildFile("03/newest", { ageMs: 1 * HOUR });
        const fileSize = await h.diskUsage(oldest);

        // Four files against a 3-file limit: over, so evict down to the
        // 1.5-file target, which leaves only the newest.
        const caches = h.manager({ buildCacheLimitBytes: 3 * fileSize });
        await caches.trim();
        expect(await h.exists(oldest)).toBe(false);
        expect(await h.exists(older)).toBe(false);
        expect(await h.exists(newer)).toBe(false);
        expect(await h.exists(newest)).toBe(true);
      });

      it("measures disk usage, not apparent size", async ({ h }) => {
        // 10 MiB apparent size, ~0 bytes allocated.
        const sparse = await h.writeBuildFile("00/sparse", { bytes: 0 });
        await fs.truncate(sparse, 10 * (1 << 20));

        const caches = h.manager({ buildCacheLimitBytes: 1 << 20 });
        await caches.trim();
        expect(await h.exists(sparse)).toBe(true);
      });

      it("evicts the stale entries it can when some are undeletable", async ({
        h,
      }) => {
        const locked = await h.writeBuildFile("00/locked/entry", {
          ageMs: 8 * DAY,
        });
        const evictable = await h.writeBuildFile("01/evictable", {
          ageMs: 8 * DAY,
        });
        const fresh = await h.writeBuildFile("02/fresh", { ageMs: 1 * HOUR });
        // A read-only parent makes rm fail for this entry only.
        await fs.chmod(path.dirname(locked), 0o555);

        await h.manager().trim();
        expect(await h.exists(locked)).toBe(true);
        expect(await h.exists(evictable)).toBe(false);
        expect(await h.exists(fresh)).toBe(true);
      });

      it("continues LRU eviction when some deletions fail", async ({ h }) => {
        const oldest = await h.writeBuildFile("00/locked/oldest", {
          ageMs: 4 * HOUR,
        });
        const older = await h.writeBuildFile("01/older", { ageMs: 3 * HOUR });
        const newest = await h.writeBuildFile("02/newest", { ageMs: 1 * HOUR });
        await fs.chmod(path.dirname(oldest), 0o555);
        const fileSize = await h.diskUsage(older);

        // Three files against a 2-file limit: reaching the 1-file target
        // means evicting oldest and older; only older can be deleted.
        const caches = h.manager({ buildCacheLimitBytes: 2 * fileSize });
        await caches.trim();
        expect(await h.exists(oldest)).toBe(true);
        expect(await h.exists(older)).toBe(false);
        expect(await h.exists(newest)).toBe(true);
      });

      it("handles thousands of nested files", async ({ h }) => {
        const keep: string[] = [];
        const evict: string[] = [];
        for (let i = 0; i < 2000; i++) {
          const rel = `${i % 16}/${Math.floor(i / 16) % 16}/f${i}`;
          if (i % 2 === 0) {
            evict.push(await h.writeBuildFile(rel, { ageMs: 8 * DAY }));
          } else {
            keep.push(await h.writeBuildFile(rel, { ageMs: 1 * HOUR }));
          }
        }

        await h.manager().trim();
        const survivors = await Promise.all(keep.map((p) => h.exists(p)));
        const evicted = await Promise.all(evict.map((p) => h.exists(p)));
        expect(survivors.every(Boolean)).toBe(true);
        expect(evicted.some(Boolean)).toBe(false);
      });
    });

    describe("mod cache", () => {
      it("leaves it alone when under the limit", async ({ h }) => {
        const mod = await h.writeModFile("example.com/mod@v1/go.mod");

        await h.manager().trim();
        expect(await h.exists(mod)).toBe(true);
      });

      it("wipes and recreates it when over the limit", async ({ h }) => {
        const mod = await h.writeModFile("example.com/mod@v1/go.mod");

        const caches = h.manager({ modCacheLimitBytes: 0 });
        await caches.trim();
        expect(await h.exists(mod)).toBe(false);
        expect(await fs.readdir(caches.modCachePath)).toEqual([]);
      });

      it("survives a failed wipe", async ({ h }) => {
        const writable = await h.writeModFile("example.com/other@v1/go.mod");
        const readOnly = await h.writeModFile("example.com/mod@v1/go.mod");
        // Mimic the real mod cache: read-only files in read-only dirs, which
        // non-sudo rm cannot delete.
        await fs.chmod(readOnly, 0o444);
        await fs.chmod(path.dirname(readOnly), 0o555);

        await h.manager({ modCacheLimitBytes: 0 }).trim();
        // rm -rf deletes everything it can before reporting failure; only
        // the undeletable module survives.
        expect(await h.exists(readOnly)).toBe(true);
        expect(await h.exists(writable)).toBe(false);
      });

      it("wipes with sudo and shell-quotes the path", async ({ h }) => {
        // A fake sudo on PATH records its invocation, then runs the command.
        const binDir = path.join(h.tmp, "bin");
        const sudoLog = path.join(h.tmp, "sudo.log");
        await fs.mkdir(binDir);
        await fs.writeFile(
          path.join(binDir, "sudo"),
          `#!/bin/sh\necho "$@" >> ${shellQuote(sudoLog)}\nexec "$@"\n`,
          { mode: 0o755 },
        );
        vi.stubEnv("PATH", `${binDir}:${process.env.PATH}`);

        // Without quoting, the space and apostrophe would break the command.
        const disk = path.join(h.tmp, "sticky disk's");
        const caches = new GoCacheManager(disk, { modCacheLimitBytes: 0 });
        const mod = path.join(caches.modCachePath, "example.com/mod@v1/go.mod");
        await fs.mkdir(path.dirname(mod), { recursive: true });
        await fs.writeFile(mod, "data");

        await caches.trim();
        expect(await h.exists(mod)).toBe(false);
        expect(await fs.readFile(sudoLog, "utf8")).toBe(
          `rm -rf ${caches.modCachePath}\n`,
        );
      });
    });

    describe("missing or empty disk", () => {
      it("is a no-op when the dirs do not exist", async ({ h }) => {
        await expect(h.manager().trim()).resolves.toBeUndefined();
      });

      it("is a no-op when both caches are empty", async ({ h }) => {
        const caches = h.manager();
        await fs.mkdir(caches.buildCachePath, { recursive: true });
        await fs.mkdir(caches.modCachePath, { recursive: true });
        await expect(caches.trim()).resolves.toBeUndefined();
      });
    });
  });
});

/** Parses GITHUB_ENV heredoc entries (NAME<<DELIM\nvalue\nDELIM). */
function parseGithubEnv(contents: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const m of contents.matchAll(/^(\w+)<<(\S+)\n(.*)\n\2$/gm)) {
    entries[m[1]] = m[3];
  }
  return entries;
}

interface TestFileOptions {
  ageMs?: number;
  bytes?: number;
}

class TestHarness {
  static async new(opts: {
    onTestFinished: (fn: () => Promise<void>) => void;
  }): Promise<TestHarness> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "go-cache-test-"));
    opts.onTestFinished(async () => {
      vi.unstubAllEnvs();
      // Some tests leave read-only directories behind.
      await execAsync(`chmod -R u+w ${shellQuote(tmp)}`).catch(() => undefined);
      await fs.rm(tmp, { recursive: true, force: true });
    });
    return new TestHarness(tmp);
  }

  private readonly disk: string;

  private constructor(readonly tmp: string) {
    this.disk = path.join(tmp, "disk");
  }

  manager(opts: GoCacheOptions = {}): GoCacheManager {
    return new GoCacheManager(this.disk, { sudo: false, ...opts });
  }

  /** Writes a file under GOCACHE and returns its absolute path. */
  writeBuildFile(rel: string, opts?: TestFileOptions): Promise<string> {
    return this.write(path.join(this.manager().buildCachePath, rel), opts);
  }

  /** Writes a file under GOMODCACHE and returns its absolute path. */
  writeModFile(rel: string, opts?: TestFileOptions): Promise<string> {
    return this.write(path.join(this.manager().modCachePath, rel), opts);
  }

  private async write(
    filePath: string,
    { ageMs = 0, bytes = 4096 }: TestFileOptions = {},
  ): Promise<string> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.alloc(bytes, 1));
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs);
      await fs.utimes(filePath, t, t);
    }
    return filePath;
  }

  async diskUsage(filePath: string): Promise<number> {
    return (await fs.stat(filePath)).blocks * 512;
  }

  exists(filePath: string): Promise<boolean> {
    return fs.access(filePath).then(
      () => true,
      () => false,
    );
  }
}
