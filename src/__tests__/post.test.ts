import * as core from "@actions/core";
import { findMountedDevice, unmount } from "../mount";
import { MountReport, sendMountReport } from "../mount-report";
import { createStickyDiskClient } from "../utils";

jest.mock("@actions/core", () => ({
  getState: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
}));
jest.mock("../mount", () => ({
  findMountedDevice: jest.fn(),
  getFilesystemUsedField: jest.fn(),
  unmount: jest.fn(),
}));
jest.mock("../utils", () => ({ createStickyDiskClient: jest.fn() }));
jest.mock("../mount-report", () => ({
  parseStateMs: jest.fn(() => 0),
  sendMountReport: jest.fn(),
}));

async function runPost(state: Record<string, string>): Promise<MountReport> {
  jest.mocked(core.getState).mockImplementation((key) => state[key] || "");
  const finished = new Promise<MountReport>((resolve) => {
    jest.mocked(sendMountReport).mockImplementation(async (report) => {
      resolve(report);
      return true;
    });
  });
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../post");
  });
  return finished;
}

describe("post mount ownership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("leaves an existing mount alone when this invocation failed to expose a disk", async () => {
    jest.mocked(findMountedDevice).mockResolvedValue("/dev/vdh");

    const report = await runPost({
      STICKYDISK_PATH: "/home/runner/go/pkg/mod",
      STICKYDISK_KEY: "gomod-X64",
      STICKYDISK_ERROR: "true",
    });

    expect(findMountedDevice).not.toHaveBeenCalled();
    expect(unmount).not.toHaveBeenCalled();
    expect(createStickyDiskClient).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      expose_id: "",
      setup_outcome: "setup_fallback",
      skip_reason: "setup_error",
      unmount_ms: 0,
    });
  });

  it("also skips mount cleanup when setup saved no exposure or error", async () => {
    const report = await runPost({
      STICKYDISK_PATH: "/mnt/cache",
      STICKYDISK_KEY: "cache",
    });

    expect(findMountedDevice).not.toHaveBeenCalled();
    expect(unmount).not.toHaveBeenCalled();
    expect(report.skip_reason).toBe("not_mounted");
  });

  it("still checks the mount after exposing a disk even if later setup failed", async () => {
    jest.mocked(findMountedDevice).mockResolvedValue(null);

    const report = await runPost({
      STICKYDISK_PATH: "/mnt/cache",
      STICKYDISK_KEY: "cache",
      STICKYDISK_EXPOSE_ID: "expose-1",
      STICKYDISK_ERROR: "true",
    });

    expect(findMountedDevice).toHaveBeenCalledWith("/mnt/cache");
    expect(report).toMatchObject({
      expose_id: "expose-1",
      skip_reason: "setup_error",
    });
  });
});
