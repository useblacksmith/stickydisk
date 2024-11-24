import fsPromises from "node:fs/promises";
import { getInput, logError } from "gha-utils";

try {
  const path = getInput("path");
  await fsPromises.mkdir(path, { recursive: true });
} catch (err) {
  logError(err);
  process.exitCode = 1;
}
