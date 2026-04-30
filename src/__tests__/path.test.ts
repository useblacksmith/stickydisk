import {
  getWorkspaceLocalParentToChown,
  normalizeMountPath,
  shellQuote,
} from "../path";

describe("path helpers", () => {
  it("normalizes tilde and relative mount paths before saving state", () => {
    const options = {
      cwd: "/home/runner/_work/repo/repo",
      home: "/home/runner",
    };

    expect(normalizeMountPath("~", options)).toBe("/home/runner");
    expect(normalizeMountPath("~/.npm", options)).toBe("/home/runner/.npm");
    expect(normalizeMountPath(".nx/cache", options)).toBe(
      "/home/runner/_work/repo/repo/.nx/cache",
    );
  });

  it("only returns workspace-local nested parents for ownership repair", () => {
    const cwd = "/home/runner/_work/repo/repo";

    expect(
      getWorkspaceLocalParentToChown(
        "/home/runner/_work/repo/repo/.nx/cache",
        cwd,
      ),
    ).toBe("/home/runner/_work/repo/repo/.nx");

    expect(getWorkspaceLocalParentToChown("/home/runner/.npm", cwd)).toBeNull();
    expect(getWorkspaceLocalParentToChown(`${cwd}/cache`, cwd)).toBeNull();
  });

  it("quotes shell paths containing apostrophes", () => {
    expect(shellQuote("/tmp/a'b")).toBe("'/tmp/a'\\''b'");
  });
});
