import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { checkPreviousStepFailures } from "../step-checker";

async function runnerWithWorkerLog(contents: string): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "step-checker-"));
  const diag = path.join(base, "_diag");
  await fs.mkdir(diag);
  await fs.writeFile(
    path.join(diag, "Worker_20260805-000000-utc.log"),
    contents,
  );
  return base;
}

describe("checkPreviousStepFailures", () => {
  it('detects the runner\'s single-l "Canceled" spelling', async () => {
    const base = await runnerWithWorkerLog("Step result: Canceled\n");
    await expect(checkPreviousStepFailures(base)).resolves.toMatchObject({
      hasFailures: true,
    });
  });

  it("detects a canceled result in JSON form", async () => {
    const base = await runnerWithWorkerLog('{"result": "canceled"}\n');
    await expect(checkPreviousStepFailures(base)).resolves.toMatchObject({
      hasFailures: true,
    });
  });

  it("still detects the double-l spelling", async () => {
    const base = await runnerWithWorkerLog("Step result: Cancelled\n");
    await expect(checkPreviousStepFailures(base)).resolves.toMatchObject({
      hasFailures: true,
    });
  });

  it("still detects failures", async () => {
    const base = await runnerWithWorkerLog("Step result: Failed\n");
    await expect(checkPreviousStepFailures(base)).resolves.toMatchObject({
      hasFailures: true,
    });
  });

  it("reports no failures for a clean run", async () => {
    const base = await runnerWithWorkerLog("Step result: Succeeded\n");
    await expect(checkPreviousStepFailures(base)).resolves.toMatchObject({
      hasFailures: false,
      failedCount: 0,
    });
  });

  it("reports an error when no worker log exists", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "step-checker-"));
    const result = await checkPreviousStepFailures(base);
    expect(result.hasFailures).toBe(false);
    expect(result.error).toBeDefined();
  });
});
