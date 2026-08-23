import { CommitIntent } from "@buf/blacksmith_vm-agent.bufbuild_es/stickydisk/v1/stickydisk_pb";

// commitIntentFromMode maps the action's commit input to the wire enum. The
// enum is the canonical in-code representation of the commit mode; the raw
// string survives only at the boundaries (action input, GitHub Actions state,
// log messages).
export function commitIntentFromMode(commitMode: string): CommitIntent {
  switch (commitMode) {
    case "true":
      return CommitIntent.ALWAYS;
    case "false":
      return CommitIntent.NEVER;
    case "if-missing":
      return CommitIntent.IF_MISSING;
    case "on-change":
      return CommitIntent.ON_CHANGE;
    default:
      return CommitIntent.UNSPECIFIED;
  }
}

export { CommitIntent };
