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
    expect(verdict.summary).toContain(`usage at mount ${formatBytes(initial)}`);
    expect(verdict.summary).toContain(
      `usage at teardown ${formatBytes(initial + ON_CHANGE_THRESHOLD_BYTES)}`,
    );
    expect(verdict.summary).toContain(
      `change +${ON_CHANGE_THRESHOLD_BYTES} bytes`,
    );
    expect(verdict.summary).toContain(
      `more than ${ON_CHANGE_THRESHOLD_BYTES} bytes between mount and teardown`,
    );
    expect(verdict.summary).toContain("verdict: skip commit");
  });

  it("commits when usage grew past the threshold", () => {
    const verdict = evaluateOnChangeCommit(
      String(initial),
      initial + ON_CHANGE_THRESHOLD_BYTES + 1,
    );
    expect(verdict.commit).toBe(true);
    expect(verdict.summary).toContain(
      `change +${ON_CHANGE_THRESHOLD_BYTES + 1} bytes`,
    );
    expect(verdict.summary).toContain("verdict: request commit");
  });

  it("commits when usage shrank past the threshold", () => {
    const verdict = evaluateOnChangeCommit(
      String(initial),
      initial - (1 << 20),
    );
    expect(verdict.commit).toBe(true);
    expect(verdict.summary).toContain(`change -${1 << 20} bytes`);
    expect(verdict.summary).toContain("verdict: request commit");
  });

  it("commits to be safe when no usage was recorded at mount", () => {
    const verdict = evaluateOnChangeCommit("", initial);
    expect(verdict.commit).toBe(true);
    expect(verdict.summary).toContain("no filesystem usage was recorded");
    expect(verdict.summary).toContain("verdict: request commit (to be safe)");
  });

  it("commits to be safe when the recorded usage is not a number", () => {
    const verdict = evaluateOnChangeCommit("garbage", initial);
    expect(verdict.commit).toBe(true);
    expect(verdict.summary).toContain('invalid ("garbage")');
    expect(verdict.summary).toContain("verdict: request commit (to be safe)");
  });

  it("commits to be safe when usage at teardown could not be measured", () => {
    const verdict = evaluateOnChangeCommit(String(initial), null);
    expect(verdict.commit).toBe(true);
    expect(verdict.summary).toContain(`usage at mount ${formatBytes(initial)}`);
    expect(verdict.summary).toContain("could not be measured");
    expect(verdict.summary).toContain("verdict: request commit (to be safe)");
  });
});

describe("formatBytes", () => {
  it("renders bytes with a GiB approximation", () => {
    expect(formatBytes(1610612736)).toBe("1610612736 bytes (1.50 GiB)");
    expect(formatBytes(0)).toBe("0 bytes (0.00 GiB)");
  });
});
