import { homedir } from "os";
import * as path from "path";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function normalizeMountPath(
  inputPath: string,
  options?: { cwd?: string; home?: string },
): string {
  const home = options?.home ?? homedir();
  const cwd = options?.cwd ?? process.cwd();

  if (inputPath === "~") {
    return home;
  }

  if (inputPath.startsWith("~/")) {
    const segments = inputPath
      .slice(2)
      .split(/[/\\]/)
      .filter((segment) => segment !== "" && segment !== "." && segment !== "..");

    return path.normalize([home, ...segments].join(path.sep));
  }

  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath);
  }

  return path.resolve(cwd, inputPath);
}

export function getWorkspaceLocalParentToChown(
  mountPath: string,
  cwd = process.cwd(),
): string | null {
  const workspacePath = path.resolve(cwd);
  const parentPath = path.dirname(path.resolve(mountPath));

  if (
    parentPath !== workspacePath &&
    parentPath.startsWith(`${workspacePath}${path.sep}`)
  ) {
    return parentPath;
  }

  return null;
}
