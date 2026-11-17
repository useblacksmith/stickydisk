import { jobOutcomeFromStatus } from "../job-status";

describe("jobOutcomeFromStatus", () => {
  it("commits only on a successful job", () => {
    expect(jobOutcomeFromStatus("success")).toBe("success");
    expect(jobOutcomeFromStatus("Success\n")).toBe("success");
  });

  it("treats a failed or cancelled job as failed", () => {
    expect(jobOutcomeFromStatus("failure")).toBe("failed");
    expect(jobOutcomeFromStatus("cancelled")).toBe("failed");
    expect(jobOutcomeFromStatus("canceled")).toBe("failed");
  });

  it("does not guess when the status is missing or unrecognised", () => {
    expect(jobOutcomeFromStatus("")).toBe("unknown");
    expect(jobOutcomeFromStatus("skipped")).toBe("unknown");
  });
});
