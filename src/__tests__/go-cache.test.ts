import { describe, expect, test } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { exec } from "child_process";
import { GoCacheManager, GoCacheOptions } from "../go-cache";

const execAsync = promisify(exec);
const DAY_MS = 86400 * 1000;

const it = test.extend<{ h: TestHarness }>({
  h: async ({ onTestFinished }, use) => {
    await use(await TestHarness.new({ onTestFinished }));
  },
});

describe("GoCacheManager", () => {
  describe("paths", () => {
    it("places both caches under the sticky disk mount", () => {
      const caches = new GoCacheManager("/mnt/go-cache");
      expect(caches.buildCachePath).toBe("/mnt/go-cache/go/build");
      expect(caches.modCachePath).toBe("/mnt/go-cache/go/mod");
    });
  });

  describe("setup", () => {
    it("creates both cache dirs and exports GOCACHE/GOMODCACHE", async ({
      h,
    }) => {
      const saved = {
        GITHUB_ENV: process.env.GITHUB_ENV,
        GOCACHE: process.env.GOCACHE,
        GOMODCACHE: process.env.GOMODCACHE,
      };
      const envFile = path.join(h.tmp, "github.env");
      await fs.writeFile(envFile, "");
      process.env.GITHUB_ENV = envFile;
      try {
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
      } finally {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }
    });
  });

  describe("build cache trimming", () => {
    it("returns false and keeps everything when under the limit", async ({
      h,
    }) => {
      const caches = h.manager();
      const a = path.join(caches.buildCachePath, "00", "a");
      const b = path.join(caches.buildCachePath, "01", "b");
      await h.writeFileAged(a);
      await h.writeFileAged(b);
      await fs.mkdir(caches.modCachePath, { recursive: true });

      expect(await caches.trim()).toBe(false);
      expect(await h.exists(a)).toBe(true);
      expect(await h.exists(b)).toBe(true);
    });

    it("evicts entries older than the max age and keeps fresh ones", async ({
      h,
    }) => {
      const caches = h.manager();
      const stale = path.join(caches.buildCachePath, "00", "stale");
      const fresh = path.join(caches.buildCachePath, "01", "fresh");
      await h.writeFileAged(stale, 8 * DAY_MS);
      await h.writeFileAged(fresh, 1 * DAY_MS);
      await fs.mkdir(caches.modCachePath, { recursive: true });

      expect(await caches.trim()).toBe(true);
      expect(await h.exists(stale)).toBe(false);
      expect(await h.exists(fresh)).toBe(true);
    });

    it("LRU-evicts oldest entries until the cache fits the limit", async ({
      h,
    }) => {
      const names = ["oldest", "older", "newer", "newest"];
      const caches0 = h.manager();
      const paths = names.map((n, i) =>
        path.join(caches0.buildCachePath, `0${i}`, n),
      );
      for (let i = 0; i < paths.length; i++) {
        // Ages: oldest=4h ... newest=1h, all well within the max age.
        await h.writeFileAged(paths[i], (paths.length - i) * 3600 * 1000);
      }
      await fs.mkdir(caches0.modCachePath, { recursive: true });

      const fileSize = await h.diskUsage(paths[0]);
      const caches = h.manager({ buildCacheLimitBytes: 3 * fileSize });

      expect(await caches.trim()).toBe(true);
      expect(await h.exists(paths[0])).toBe(false);
      expect(await h.exists(paths[1])).toBe(true);
      expect(await h.exists(paths[2])).toBe(true);
      expect(await h.exists(paths[3])).toBe(true);
    });

    it("measures disk usage, not apparent size", async ({ h }) => {
      const caches = h.manager({ buildCacheLimitBytes: 1 << 20 });
      const sparse = path.join(caches.buildCachePath, "00", "sparse");
      await fs.mkdir(path.dirname(sparse), { recursive: true });
      await fs.writeFile(sparse, "");
      // 10 MiB apparent size, ~0 bytes allocated.
      await fs.truncate(sparse, 10 * (1 << 20));
      await fs.mkdir(caches.modCachePath, { recursive: true });

      expect(await caches.trim()).toBe(false);
      expect(await h.exists(sparse)).toBe(true);
    });

    it("handles thousands of files across nested directories", async ({
      h,
    }) => {
      const caches0 = h.manager();
      const keep: string[] = [];
      const evict: string[] = [];
      for (let i = 0; i < 2000; i++) {
        const p = path.join(
          caches0.buildCachePath,
          `${i % 16}`,
          `${Math.floor(i / 16) % 16}`,
          `f${i}`,
        );
        if (i % 2 === 0) {
          await h.writeFileAged(p, 8 * DAY_MS);
          evict.push(p);
        } else {
          await h.writeFileAged(p, 1 * 3600 * 1000);
          keep.push(p);
        }
      }
      await fs.mkdir(caches0.modCachePath, { recursive: true });

      expect(await caches0.trim()).toBe(true);
      const survivors = await Promise.all(keep.map(h.exists));
      const evicted = await Promise.all(evict.map(h.exists));
      expect(survivors.every(Boolean)).toBe(true);
      expect(evicted.some(Boolean)).toBe(false);
    });
  });

  describe("mod cache trimming", () => {
    it("leaves the mod cache alone when under the limit", async ({ h }) => {
      const caches = h.manager();
      const mod = path.join(
        caches.modCachePath,
        "example.com",
        "mod@v1",
        "go.mod",
      );
      await h.writeFileAged(mod);
      await fs.mkdir(caches.buildCachePath, { recursive: true });

      expect(await caches.trim()).toBe(false);
      expect(await h.exists(mod)).toBe(true);
    });

    it("wipes and recreates the mod cache when over the limit", async ({
      h,
    }) => {
      const caches = h.manager({ modCacheLimitBytes: 0 });
      const mod = path.join(
        caches.modCachePath,
        "example.com",
        "mod@v1",
        "go.mod",
      );
      await h.writeFileAged(mod);
      await fs.mkdir(caches.buildCachePath, { recursive: true });

      expect(await caches.trim()).toBe(true);
      expect(await h.exists(mod)).toBe(false);
      expect(await fs.readdir(caches.modCachePath)).toEqual([]);
    });

    it("returns false and leaves contents intact when the wipe fails", async ({
      h,
    }) => {
      const caches = h.manager({ modCacheLimitBytes: 0 });
      const modDir = path.join(caches.modCachePath, "example.com", "mod@v1");
      const mod = path.join(modDir, "go.mod");
      await h.writeFileAged(mod);
      await fs.mkdir(caches.buildCachePath, { recursive: true });
      // Mimic the real mod cache: read-only files in read-only dirs, which
      // non-sudo rm cannot delete.
      await fs.chmod(mod, 0o444);
      await fs.chmod(modDir, 0o555);

      expect(await caches.trim()).toBe(false);
      expect(await h.exists(mod)).toBe(true);
    });
  });

  describe("trim on a missing or empty disk", () => {
    it("returns false when the cache dirs do not exist", async ({ h }) => {
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

class TestHarness {
  static async new(opts: {
    onTestFinished: (fn: () => Promise<void>) => void;
  }): Promise<TestHarness> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "go-cache-test-"));
    opts.onTestFinished(async () => {
      // Some tests leave read-only directories behind.
      await execAsync(`chmod -R u+w ${JSON.stringify(tmp)}`).catch(
        () => undefined,
      );
      await fs.rm(tmp, { recursive: true, force: true });
    });
    return new TestHarness(tmp);
  }

  readonly disk: string;

  private constructor(readonly tmp: string) {
    this.disk = path.join(tmp, "disk");
  }

  manager(options: GoCacheOptions = {}): GoCacheManager {
    return new GoCacheManager(this.disk, { sudo: false, ...options });
  }

  async writeFileAged(
    filePath: string,
    ageMs = 0,
    bytes = 4096,
  ): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.alloc(bytes, 1));
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs);
      await fs.utimes(filePath, t, t);
    }
  }

  async diskUsage(filePath: string): Promise<number> {
    const stat = await fs.stat(filePath);
    return stat.blocks * 512;
  }

  exists = (filePath: string): Promise<boolean> => {
    return fs.access(filePath).then(
      () => true,
      () => false,
    );
  };
}
