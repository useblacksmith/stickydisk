/**
 * Resolve a leading `~` or `~/` to `$HOME`. Shell commands expand tilde
 * automatically, but Node.js APIs and `mount | grep` do not, so state
 * must store the resolved path for the post-run to match the mount table.
 */
export function resolveTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return (process.env.HOME ?? "/home/runner") + p.slice(1);
  }
  return p;
}
