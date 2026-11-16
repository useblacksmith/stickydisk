/**
 * Shell prefix for a command that needs root. Job containers usually run as
 * root and ship without sudo, so the command runs directly there and through
 * sudo everywhere else.
 */
export function sudoPrefix(
  uid: number | undefined = process.getuid?.(),
): string {
  return uid === 0 ? "" : "sudo ";
}

/** Argv form of `sudoPrefix`, for commands run without a shell. */
export function asRoot(
  argv: string[],
  uid: number | undefined = process.getuid?.(),
): string[] {
  return uid === 0 ? argv : ["sudo", ...argv];
}
