import { tmpdir } from "os";
import { proto3 } from "@bufbuild/protobuf";
import {
  CommandRunner,
  findMountedDevice,
  getFilesystemUsedField,
  parseMountSource,
  parseFstrimTimeoutSecs,
  parseTrimmedBytes,
  trimFilesystem,
  unmount,
  decodeVarint,
  fstrimTimeoutSecsFrom,
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

  it("runs fstrim under timeout and sudo with the path as one argv element", async () => {
    const { run, calls } = recordingRunner({
      timeout: { stdout: `${hostilePath}: 1 GiB (1073741824 bytes) trimmed\n` },
    });

    const result = await trimFilesystem(hostilePath, 5, run);

    expect(calls).toEqual([
      {
        file: "timeout",
        args: ["5", "sudo", "fstrim", "-v", "--", hostilePath],
      },
    ]);
    expect(result.outcome).toBe("trimmed");
    expect(result.trimmedBytes).toBe(1073741824);
    expect(result.detail).toBe("");
  });

  it("parses the host fstrim budget from the RPC bigint or saved state", () => {
    expect(parseFstrimTimeoutSecs(BigInt(5))).toBe(5);
    expect(parseFstrimTimeoutSecs(5)).toBe(5);
    expect(parseFstrimTimeoutSecs("5")).toBe(5);
    expect(parseFstrimTimeoutSecs("2.9")).toBe(2);
    expect(parseFstrimTimeoutSecs(BigInt(0))).toBe(0);
    expect(parseFstrimTimeoutSecs(-1)).toBe(0);
    expect(parseFstrimTimeoutSecs("")).toBe(0);
    expect(parseFstrimTimeoutSecs(undefined)).toBe(0);
    expect(parseFstrimTimeoutSecs("nope")).toBe(0);
  });

  it("parses the byte count from fstrim -v across util-linux output shapes", () => {
    expect(parseTrimmedBytes("/mnt: 0 B (0 bytes) trimmed\n")).toBe(0);
    expect(
      parseTrimmedBytes(
        "/mnt: 1.2 GiB (1288490188 bytes) trimmed on /dev/vdb\n",
      ),
    ).toBe(1288490188);
    expect(parseTrimmedBytes("")).toBeNull();
    expect(parseTrimmedBytes("fstrim: /mnt: FITRIM ioctl failed")).toBeNull();
  });

  it("never throws from trimFilesystem and classifies the failure", async () => {
    const unsupported = Object.assign(new Error("Command failed"), {
      code: 1,
      stderr: "fstrim: /mnt/cache: the discard operation is not supported\n",
    });
    expect(
      await trimFilesystem(
        "/mnt/cache",
        5,
        recordingRunner({ timeout: unsupported }).run,
      ),
    ).toMatchObject({
      outcome: "failed",
      trimmedBytes: null,
      detail: "fstrim: /mnt/cache: the discard operation is not supported",
    });

    const timedOut = Object.assign(new Error("Command failed"), {
      code: 124,
      stderr: "",
    });
    expect(
      await trimFilesystem(
        "/mnt/cache",
        5,
        recordingRunner({ timeout: timedOut }).run,
      ),
    ).toMatchObject({
      outcome: "timed_out",
      trimmedBytes: null,
      detail: "timed out after 5s",
    });

    const missing = Object.assign(new Error("spawn timeout ENOENT"), {
      code: "ENOENT",
    });
    expect(
      await trimFilesystem(
        "/mnt/cache",
        5,
        recordingRunner({ timeout: missing }).run,
      ),
    ).toMatchObject({
      outcome: "failed",
      detail: "spawn timeout ENOENT",
    });
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

describe("fstrimTimeoutSecsFrom", () => {
  it("prefers the typed field when the proto package knows it", () => {
    expect(
      fstrimTimeoutSecsFrom({ fstrimTimeoutSecs: BigInt(7) }, [
        { no: 8, wireType: 0, data: new Uint8Array([5]) },
      ]),
    ).toBe(7);
  });

  it("falls back to unknown field 8 from an older proto package", () => {
    expect(
      fstrimTimeoutSecsFrom({}, [
        { no: 3, wireType: 2, data: new Uint8Array([1, 2]) },
        { no: 8, wireType: 0, data: new Uint8Array([0x80, 0x01]) },
      ]),
    ).toBe(128);
    expect(
      fstrimTimeoutSecsFrom({}, [
        { no: 8, wireType: 2, data: new Uint8Array([5]) },
      ]),
    ).toBe(0);
    expect(fstrimTimeoutSecsFrom({}, [])).toBe(0);
  });

  it("reads the field off a real response decoded by the bundled package", () => {
    // field 8, varint wire type => tag 0x40; value 5
    // A message type that predates the field, like a bundled proto package
    // built before fstrim_timeout_secs existed.
    const OldResponse = proto3.makeMessageType("test.OldResponse", []);
    const response = OldResponse.fromBinary(new Uint8Array([0x40, 0x05]));
    const unknown = response.getType().runtime.bin.listUnknownFields(response);
    expect(fstrimTimeoutSecsFrom(response, unknown)).toBe(5);
  });

  it("decodes varints and rejects malformed ones", () => {
    expect(decodeVarint(new Uint8Array([0]))).toBe(0);
    expect(decodeVarint(new Uint8Array([0xac, 0x02]))).toBe(300);
    expect(decodeVarint(new Uint8Array([0x80]))).toBeNull();
    expect(decodeVarint(new Uint8Array([0x05, 0x05]))).toBeNull();
    expect(decodeVarint(new Uint8Array([]))).toBeNull();
  });
});
