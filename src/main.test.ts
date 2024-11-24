import { jest } from "@jest/globals";
import fsPromises from "node:fs/promises";
import os from "node:os";

beforeAll(() => {
  process.chdir(os.tmpdir());
});

beforeEach(async () => {
  await fsPromises.rm("path", { recursive: true, force: true });
  jest.resetModules();
});

it("should create a directory recursively", async () => {
  process.env.INPUT_PATH = "path/to/new/directory";
  await import("./main.js");

  await fsPromises.access("path/to/new/directory");
  expect(process.exitCode).toBeUndefined();
});

it("should fail to create a directory because a file already exists", async () => {
  await fsPromises.writeFile("path", "a data");

  process.env.INPUT_PATH = "path/to/new/directory";
  await import("./main.js");

  expect(process.exitCode).toBe(1);
  process.exitCode = undefined;
});

afterAll(async () => {
  await fsPromises.rm("path", { recursive: true, force: true });
});
