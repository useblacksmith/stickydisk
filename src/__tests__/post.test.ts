import * as core from "@actions/core";
import { findMountedDevice, trimFilesystem, unmount } from "../mount";
import { MountReport, sendMountReport } from "../mount-report";
import { createStickyDiskClient } from "../utils";

jest.mock("@actions/core", () => ({
  getState: jest.fn(),
  getInput: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
}));
jest.mock("../mount", () => ({
  findMountedDevice: jest.fn(),
  getFilesystemUsedField: jest.fn(),
  parseFstrimMinExtentBytes: jest.fn((v) => Number(v) || 0),
  parseFstrimTimeoutSecs: jest.fn((v) => Number(v) || 0),
  trimFilesystem: jest.fn(),
  unmount: jest.fn(),
}));
jest.mock("../utils", () => ({ createStickyDiskClient: jest.fn() }));
jest.mock("../mount-report", () => ({
  parseStateMs: jest.fn(() => 0),
  sendMountReport: jest.fn(),
}));

async function runPost(
  state: Record<string, string>,
  jobStatus = "success",
): Promise<MountReport> {
  jest.mocked(core.getState).mockImplementation((key) => state[key] || "");
  jest.mocked(core.getInput).mockReturnValue(jobStatus);
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

describe("post fstrim before unmount", () => {
  const mounted = {
    STICKYDISK_PATH: "/mnt/cache",
    STICKYDISK_KEY: "cache",
    STICKYDISK_EXPOSE_ID: "expose-1",
    STICKYDISK_FSTRIM_TIMEOUT_SECS: "5",
    STICKYDISK_FSTRIM_MIN_EXTENT_BYTES: "4194304",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(findMountedDevice).mockResolvedValue("/dev/vdh");
    jest.mocked(trimFilesystem).mockResolvedValue({
      outcome: "ok",
      durationMs: 40,
      trimmedBytes: 1073741824,
      detail: "",
    });
    jest.mocked(createStickyDiskClient).mockReturnValue({
      commitStickyDisk: jest.fn(async () => ({})),
      cleanupStickyDisk: jest.fn(async () => ({})),
    } as never);
  });

  it("trims with the host budget before unmount when the job succeeded", async () => {
    const order: string[] = [];
    jest.mocked(trimFilesystem).mockImplementation(async () => {
      order.push("fstrim");
      return {
        outcome: "ok",
        durationMs: 40,
        trimmedBytes: 1073741824,
        detail: "",
      };
    });
    jest.mocked(unmount).mockImplementation(async () => {
      order.push("umount");
    });

    const report = await runPost(mounted);

    expect(trimFilesystem).toHaveBeenCalledWith("/mnt/cache", 5, 4194304);
    expect(order).toEqual(["fstrim", "umount"]);
    expect(report).toMatchObject({
      skip_reason: "",
      fstrim_outcome: "ok",
      fstrim_ms: 40,
      fstrim_bytes: 1073741824,
    });
  });

  it("skips the trim when the job failed, like the commit", async () => {
    const report = await runPost(mounted, "failure");

    expect(trimFilesystem).not.toHaveBeenCalled();
    expect(unmount).toHaveBeenCalled();
    expect(report).toMatchObject({
      skip_reason: "prior_step_failure",
      fstrim_outcome: "skipped",
    });
  });

  it("skips the trim without a host budget or on a read-only mount", async () => {
    await runPost({ ...mounted, STICKYDISK_FSTRIM_TIMEOUT_SECS: "0" });
    await runPost({ ...mounted, STICKYDISK_COMMIT_MODE: "false" });

    expect(trimFilesystem).not.toHaveBeenCalled();
    expect(unmount).toHaveBeenCalledTimes(2);
  });

  it("reports a failed trim and still unmounts and commits", async () => {
    jest.mocked(trimFilesystem).mockResolvedValue({
      outcome: "unsupported",
      durationMs: 3,
      trimmedBytes: null,
      detail: "the discard operation is not supported",
    });

    const report = await runPost(mounted);

    expect(unmount).toHaveBeenCalled();
    expect(report).toMatchObject({
      skip_reason: "",
      fstrim_outcome: "unsupported",
      fstrim_bytes: 0,
    });
  });
});
