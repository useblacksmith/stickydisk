import * as core from "@actions/core";
import { exec } from "child_process";
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
jest.mock("../step-checker", () => ({
  checkPreviousStepFailures: jest.fn(async () => ({
    hasFailures: false,
    failedCount: 0,
  })),
}));
jest.mock("child_process", () => ({
  exec: jest.fn(
    (
      _cmd: string,
      cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
    ) => cb(null, { stdout: "", stderr: "" }),
  ),
}));
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

describe("post unmount sequence", () => {
  const mountedState = {
    STICKYDISK_PATH: "/mnt/cache",
    STICKYDISK_KEY: "cache",
    STICKYDISK_EXPOSE_ID: "expose-1",
  };
  const shellCommands = (): string[] =>
    jest.mocked(exec).mock.calls.map((call) => String(call[0]));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BLACKSMITH_STICKYDISK_DROP_CACHES;
    jest.mocked(findMountedDevice).mockResolvedValue("/dev/vdb");
    jest.mocked(unmount).mockResolvedValue(undefined);
  });

  afterAll(() => {
    delete process.env.BLACKSMITH_STICKYDISK_DROP_CACHES;
  });

  it("syncs, unmounts and flushes without dropping the page cache", async () => {
    const report = await runPost(mountedState);

    const commands = shellCommands();
    expect(commands).toContain("sync");
    expect(commands.some((c) => c.includes("drop_caches"))).toBe(false);
    expect(
      commands.some((c) => c.includes("blockdev --flushbufs /dev/vdb")),
    ).toBe(true);
    expect(unmount).toHaveBeenCalledWith("/mnt/cache");
    expect(report.skip_reason).toBe("");
  });

  it("drops the page cache before unmounting when opted back in", async () => {
    process.env.BLACKSMITH_STICKYDISK_DROP_CACHES = "true";
    let droppedBeforeUnmount = false;
    jest.mocked(unmount).mockImplementation(async () => {
      droppedBeforeUnmount = shellCommands().some((c) =>
        c.includes("drop_caches"),
      );
    });

    await runPost(mountedState);

    expect(droppedBeforeUnmount).toBe(true);
  });
});
