import {
  parseCacheLimitGb,
  goBuildCachePath,
  goModCachePath,
} from "../go-cache";

describe("parseCacheLimitGb", () => {
  it("returns the default for empty input", () => {
    expect(parseCacheLimitGb("", 10)).toBe(10);
    expect(parseCacheLimitGb("  ", 5)).toBe(5);
  });

  it("parses valid numbers", () => {
    expect(parseCacheLimitGb("67", 10)).toBe(67);
    expect(parseCacheLimitGb("2.5", 10)).toBe(2.5);
    expect(parseCacheLimitGb("0", 10)).toBe(0);
  });

  it("returns null for invalid values", () => {
    expect(parseCacheLimitGb("abc", 10)).toBeNull();
    expect(parseCacheLimitGb("-1", 10)).toBeNull();
    expect(parseCacheLimitGb("Infinity", 10)).toBeNull();
  });
});

describe("go cache paths", () => {
  it("places both caches under the sticky disk mount", () => {
    expect(goBuildCachePath("/mnt/go-cache")).toBe("/mnt/go-cache/go-build");
    expect(goModCachePath("/mnt/go-cache")).toBe("/mnt/go-cache/go-mod");
  });
});
