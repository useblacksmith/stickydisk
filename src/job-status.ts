// The `job-status` input defaults to `${{ job.status }}`, which the runner
// evaluates again when it starts the post step, so the post step sees the
// job's status at that moment. Unlike the runner's _diag logs, it is available
// inside job containers.
export const JOB_STATUS_INPUT = "job-status";

export type JobOutcome = "success" | "failed" | "unknown";

export function jobOutcomeFromStatus(status: string): JobOutcome {
  switch (status.trim().toLowerCase()) {
    case "success":
      return "success";
    case "failure":
    case "cancelled":
    case "canceled":
      return "failed";
    default:
      return "unknown";
  }
}
