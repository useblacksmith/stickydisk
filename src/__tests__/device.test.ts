import { waitForNonZeroDeviceSize } from "../device";
import { asRoot, sudoPrefix } from "../privilege";

function execError(code: number, stderr: string): Error {
  return Object.assign(new Error(`Command failed: ${stderr}`), {
    code,
    stderr,
  });
}

describe("privilege", () => {
  it("uses sudo unless the process is already root", () => {
    expect(sudoPrefix(1001)).toBe("sudo ");
    expect(sudoPrefix(0)).toBe("");
    expect(asRoot(["umount", "/x"], 1001)).toEqual(["sudo", "umount", "/x"]);
    expect(asRoot(["umount", "/x"], 0)).toEqual(["umount", "/x"]);
  });
});

describe("waitForNonZeroDeviceSize", () => {
  it("returns once the device reports a size", async () => {
    const commands: string[] = [];
    const sizes = ["0\n", "1073741824\n"];
    await waitForNonZeroDeviceSize(
      "/dev/vdc",
      5000,
      async (command) => {
        commands.push(command);
        return { stdout: sizes.shift() ?? "" };
      },
      "",
    );
    expect(commands).toEqual([
      "blockdev --getsize64 /dev/vdc",
      "blockdev --getsize64 /dev/vdc",
    ]);
  });

  it("fails at once, naming the missing command, instead of polling", async () => {
    let calls = 0;
    await expect(
      waitForNonZeroDeviceSize(
        "/dev/vdc",
        5000,
        async () => {
          calls++;
          throw execError(127, "/bin/sh: 1: sudo: not found\n");
        },
        "sudo ",
      ),
    ).rejects.toThrow(/sudo: not found.*needs root/);
    expect(calls).toBe(1);
  });

  it("reports the last command error at the deadline, not a zero size", async () => {
    await expect(
      waitForNonZeroDeviceSize(
        "/dev/vdc",
        0,
        async () => {
          throw execError(
            1,
            "blockdev: cannot open /dev/vdc: Permission denied\n",
          );
        },
        "",
      ),
    ).rejects.toThrow(
      "Could not read the size of /dev/vdc after 0ms: blockdev: cannot open /dev/vdc: Permission denied",
    );
  });

  it("still reports a zero size when the command keeps succeeding", async () => {
    await expect(
      waitForNonZeroDeviceSize(
        "/dev/vdc",
        0,
        async () => ({ stdout: "0\n" }),
        "",
      ),
    ).rejects.toThrow("Device /dev/vdc still reports zero size after 0ms");
  });
});
