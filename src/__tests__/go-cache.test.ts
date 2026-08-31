import { describe, expect, it } from "vitest";
import { GoCacheManager } from "../go-cache";

describe("go cache paths", () => {
  it("places both caches under the sticky disk mount", () => {
    const caches = new GoCacheManager("/mnt/go-cache");
    expect(caches.buildCachePath).toBe("/mnt/go-cache/go/build");
    expect(caches.modCachePath).toBe("/mnt/go-cache/go/mod");
  });
});
