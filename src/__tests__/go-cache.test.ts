import { goBuildCachePath, goModCachePath } from "../go-cache";

describe("go cache paths", () => {
  it("places both caches under the sticky disk mount", () => {
    expect(goBuildCachePath("/mnt/go-cache")).toBe("/mnt/go-cache/go/build");
    expect(goModCachePath("/mnt/go-cache")).toBe("/mnt/go-cache/go/mod");
  });
});
