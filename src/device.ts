import { promisify } from "util";
import { exec } from "child_process";
import { sudoPrefix } from "./privilege";

const execAsync = promisify(exec);

export type ShellRunner = (command: string) => Promise<{ stdout: string }>;

// The shell exits 127 when it cannot find the command, which no amount of
// polling fixes.
const COMMAND_NOT_FOUND_EXIT_CODE = 127;

function describeExecError(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") {
    return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

// The VM agent's sticky-disk response can arrive before the guest kernel has
// processed the virtio config-change interrupt that publishes the drive's real
// capacity (the drive is hot-attached/hydrated in place), so the device can
// transiently report a size of zero. Wait for a non-zero size before touching
// the device.
export async function waitForNonZeroDeviceSize(
  device: string,
  timeoutMs: number,
  run: ShellRunner = execAsync,
  sudo: string = sudoPrefix(),
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let lastError: unknown;
    try {
      const { stdout } = await run(`${sudo}blockdev --getsize64 ${device}`);
      const size = parseInt(stdout.trim(), 10);
      if (!isNaN(size) && size > 0) {
        return;
      }
    } catch (error) {
      if (
        (error as { code?: unknown } | null)?.code ===
        COMMAND_NOT_FOUND_EXIT_CODE
      ) {
        throw new Error(
          `Cannot read the size of ${device}: ${describeExecError(error)}. Mounting a sticky disk needs root: run the job as root, or install sudo and util-linux in the job's container image.`,
        );
      }
      // Device node may not exist yet; keep polling until the deadline.
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        lastError === undefined
          ? `Device ${device} still reports zero size after ${timeoutMs}ms`
          : `Could not read the size of ${device} after ${timeoutMs}ms: ${describeExecError(lastError)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
