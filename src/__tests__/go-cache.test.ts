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

      const envContents = await fs.readFile(envFile, "utf8");
      expect(envContents).toContain(caches.buildCachePath);
      expect(envContents).toContain(caches.modCachePath);

      // Idempotent when the dirs already exist.
      await caches.setup();
    });
  });

  describe("trim()", () => {
    describe("build cache", () => {
      it("keeps everything when under the limit", async ({ h }) => {
        const a = await h.writeFile("00/a");
        const b = await h.writeFile("01/b");

        expect(await h.manager().trim()).toBe(false);
        expect(await h.exists(a)).toBe(true);
        expect(await h.exists(b)).toBe(true);
      });

      it("evicts stale entries and keeps fresh ones", async ({ h }) => {
        const stale = await h.writeFile("00/stale", { ageMs: 8 * DAY });
        const fresh = await h.writeFile("01/fresh", { ageMs: 1 * DAY });

        expect(await h.manager().trim()).toBe(true);
        expect(await h.exists(stale)).toBe(false);
        expect(await h.exists(fresh)).toBe(true);
      });

      it("LRU-evicts oldest entries until it fits", async ({ h }) => {
        // All well within the max age, so only the size limit applies.
        const oldest = await h.writeFile("00/oldest", { ageMs: 4 * HOUR });
        const older = await h.writeFile("01/older", { ageMs: 3 * HOUR });
        const newer = await h.writeFile("02/newer", { ageMs: 2 * HOUR });
        const newest = await h.writeFile("03/newest", { ageMs: 1 * HOUR });
        const fileSize = await h.diskUsage(oldest);

        const caches = h.manager({ buildCacheLimitBytes: 3 * fileSize });
        expect(await caches.trim()).toBe(true);
        expect(await h.exists(oldest)).toBe(false);
        expect(await h.exists(older)).toBe(true);
        expect(await h.exists(newer)).toBe(true);
        expect(await h.exists(newest)).toBe(true);
      });

      it("measures disk usage, not apparent size", async ({ h }) => {
        // 10 MiB apparent size, ~0 bytes allocated.
        const sparse = await h.writeFile("00/sparse", { bytes: 0 });
        await fs.truncate(sparse, 10 * (1 << 20));

        const caches = h.manager({ buildCacheLimitBytes: 1 << 20 });
        expect(await caches.trim()).toBe(false);
        expect(await h.exists(sparse)).toBe(true);
      });

      it("handles thousands of nested files", async ({ h }) => {
        const keep: string[] = [];
        const evict: string[] = [];
        for (let i = 0; i < 2000; i++) {
          const rel = `${i % 16}/${Math.floor(i / 16) % 16}/f${i}`;
          if (i % 2 === 0) {
            evict.push(await h.writeFile(rel, { ageMs: 8 * DAY }));
          } else {
            keep.push(await h.writeFile(rel, { ageMs: 1 * HOUR }));
          }
        }

        expect(await h.manager().trim()).toBe(true);
        const survivors = await Promise.all(keep.map((p) => h.exists(p)));
        const evicted = await Promise.all(evict.map((p) => h.exists(p)));
        expect(survivors.every(Boolean)).toBe(true);
        expect(evicted.some(Boolean)).toBe(false);
      });
    });

    describe("mod cache", () => {
      it("leaves it alone when under the limit", async ({ h }) => {
        const mod = await h.writeModFile("example.com/mod@v1/go.mod");

        expect(await h.manager().trim()).toBe(false);
        expect(await h.exists(mod)).toBe(true);
      });

      it("wipes and recreates it when over the limit", async ({ h }) => {
        const mod = await h.writeModFile("example.com/mod@v1/go.mod");

        const caches = h.manager({ modCacheLimitBytes: 0 });
        expect(await caches.trim()).toBe(true);
        expect(await h.exists(mod)).toBe(false);
        expect(await fs.readdir(caches.modCachePath)).toEqual([]);
      });

      it("leaves contents intact when the wipe fails", async ({ h }) => {
        const mod = await h.writeModFile("example.com/mod@v1/go.mod");
        // Mimic the real mod cache: read-only files in read-only dirs, which
        // non-sudo rm cannot delete.
        await fs.chmod(mod, 0o444);
        await fs.chmod(path.dirname(mod), 0o555);

        expect(await h.manager({ modCacheLimitBytes: 0 }).trim()).toBe(false);
        expect(await h.exists(mod)).toBe(true);
      });
    });

    describe("missing or empty disk", () => {
      it("returns false when the dirs do not exist", async ({ h }) => {
        expect(await h.manager().trim()).toBe(false);
      });

      it("returns false when both caches are empty", async ({ h }) => {
        const caches = h.manager();
        await fs.mkdir(caches.buildCachePath, { recursive: true });
        await fs.mkdir(caches.modCachePath, { recursive: true });
        expect(await caches.trim()).toBe(false);
      });
    });
  });
});

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

  manager(options: GoCacheOptions = {}): GoCacheManager {
    return new GoCacheManager(this.disk, { sudo: false, ...options });
  }

  /** Writes a file under GOCACHE and returns its absolute path. */
  writeFile(rel: string, options?: TestFileOptions): Promise<string> {
    return this.write(path.join(this.manager().buildCachePath, rel), options);
  }

  /** Writes a file under GOMODCACHE and returns its absolute path. */
  writeModFile(rel: string, options?: TestFileOptions): Promise<string> {
    return this.write(path.join(this.manager().modCachePath, rel), options);
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
