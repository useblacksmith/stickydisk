import {
  ON_CHANGE_THRESHOLD_BYTES,
  evaluateOnChangeCommit,
  formatBytes,
} from "../on-change";

describe("evaluateOnChangeCommit", () => {
  const initial = 5 * 1024 * 1024 * 1024;

  it("skips the commit when usage moved by at most one block", () => {
    const verdict = evaluateOnChangeCommit(
      String(initial),
      initial + ON_CHANGE_THRESHOLD_BYTES,
    );
    expect(verdict.commit).toBe(false);
    expect(verdict.summary).toBe(
      `on-change: not committing, usage changed by +${ON_CHANGE_THRESHOLD_BYTES} bytes (within the ${ON_CHANGE_THRESHOLD_BYTES} byte threshold)`,
    );
  });

  it("commits when usage grew past the threshold", () => {
    const verdict = evaluateOnChangeCommit(
      String(initial),
      initial + ON_CHANGE_THRESHOLD_BYTES + 1,
    );
    expect(verdict.commit).toBe(true);
    expect(verdict.summary).toBe(
      `on-change: requesting commit, usage changed by +${ON_CHANGE_THRESHOLD_BYTES + 1} bytes (over the ${ON_CHANGE_THRESHOLD_BYTES} byte threshold)`,
    );
  });

  it("commits when usage shrank past the threshold", () => {
    const verdict = evaluateOnChangeCommit(
      String(initial),
      initial - (1 << 20),
    );
    expect(verdict.commit).toBe(true);
    expect(verdict.summary).toContain(
      `requesting commit, usage changed by -${1 << 20} bytes`,
    );
  });

  it("commits to be safe when no usage was recorded at mount", () => {
    const verdict = evaluateOnChangeCommit("", initial);
    expect(verdict.commit).toBe(true);
    expect(verdict.summary).toBe(
      "on-change: requesting commit, no usage recorded at mount",
    );
  });

  it("commits to be safe when the recorded usage is not a number", () => {
    const verdict = evaluateOnChangeCommit("garbage", initial);
    expect(verdict.commit).toBe(true);
    expect(verdict.summary).toBe(
      'on-change: requesting commit, usage recorded at mount is invalid ("garbage")',
    );
  });

  it("commits to be safe when usage at teardown could not be measured", () => {
    const verdict = evaluateOnChangeCommit(String(initial), null);
    expect(verdict.commit).toBe(true);
    expect(verdict.summary).toBe(
      "on-change: requesting commit, could not measure usage at teardown",
    );
  });
});

describe("formatBytes", () => {
  it("renders bytes with a GiB approximation", () => {
    expect(formatBytes(1610612736)).toBe("1610612736 bytes (1.50 GiB)");
    expect(formatBytes(0)).toBe("0 bytes (0.00 GiB)");
  });
});
