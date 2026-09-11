import { tmpdir } from "os";
import {
  CommandRunner,
  findMountedDevice,
  getFilesystemUsedField,
  parseMountSource,
  unmount,
} from "../mount";

// A path a workflow could feed through the `path` input; every character is
// meaningful to a shell and must reach the child process as plain filename
// bytes.
const hostilePath = "/$(id>&2).*;`touch /tmp/pwned`|\"x'y";

function recordingRunner(
  results: Record<string, { stdout: string } | Error> = {},
): { run: CommandRunner; calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];
  const run: CommandRunner = async (file, args) => {
    calls.push({ file, args });
    const result = results[file];
    if (result instanceof Error) throw result;
    return { stdout: result?.stdout ?? "", stderr: "" };
  };
  return { run, calls };
}

describe("mount helpers", () => {
  it("passes the mount path to findmnt, df, and umount as one argv element", async () => {
    const { run, calls } = recordingRunner({
      findmnt: { stdout: "/dev/vdb\n" },
      df: { stdout: "Used\n123456\n" },
    });

    expect(await findMountedDevice(hostilePath, run)).toBe("/dev/vdb");
    expect(await getFilesystemUsedField(hostilePath, run)).toBe("123456");
    await unmount(hostilePath, run);

    expect(calls).toEqual([
      {
        file: "findmnt",
        args: ["-n", "-o", "SOURCE", "--mountpoint", hostilePath],
      },
      { file: "df", args: ["-B1", "--output=used", "--", hostilePath] },
      { file: "sudo", args: ["umount", "--", hostilePath] },
    ]);
  });

  it("falls back to the mount listing and matches the target exactly", async () => {
    const listing = [
      "/dev/vda1 on / type ext4 (rw,relatime)",
      "/dev/vdb on /mnt/cache type ext4 (rw,relatime)",
      "/dev/vdc on /mnt/cache2 type ext4 (rw,relatime)",
    ].join("\n");

    expect(parseMountSource(listing, "/mnt/cache")).toBe("/dev/vdb");
    expect(parseMountSource(listing, "/mnt/cache2")).toBe("/dev/vdc");
    expect(parseMountSource(listing, "/mnt/cach")).toBeNull();
    expect(parseMountSource(listing, "/mnt")).toBeNull();

    const { run } = recordingRunner({
      findmnt: new Error("findmnt: not found"),
      mount: { stdout: listing },
    });
    expect(await findMountedDevice("/mnt/cache", run)).toBe("/dev/vdb");
    expect(await findMountedDevice("/mnt/cache/nested", run)).toBeNull();
  });

  const itOnLinux = process.platform === "linux" ? it : it.skip;

  itOnLinux("runs the real binaries without a shell", async () => {
    // With a shell in the way this path would be a glob plus a substitution;
    // through execFile it is just a filename df cannot find.
    await expect(getFilesystemUsedField(hostilePath)).rejects.toThrow();
    expect(await findMountedDevice(hostilePath)).toBeNull();

    const used = parseInt(await getFilesystemUsedField(tmpdir()), 10);
    expect(used).toBeGreaterThan(0);
    expect(await findMountedDevice("/")).not.toBeNull();
  });
});
