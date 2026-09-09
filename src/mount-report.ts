import * as core from "@actions/core";
import * as http from "http";

// The guest-side view of one sticky disk use, posted once from the post step
// to the Blacksmith agent's /internal endpoint. The agent joins it onto the
// host's lifecycle record for the same expose id; reporting is best-effort and
// never affects the job.
export const MOUNT_REPORT_METRIC_TYPE = "stickydisk_mount_report";

export type GuestSetupOutcome = "mounted" | "setup_fallback";

export type SkipReason =
  | ""
  | "commit_false"
  | "early_deny"
  | "if_missing_existing"
  | "on_change_unchanged"
  | "prior_step_failure"
  | "step_check_error"
  | "setup_error"
  | "not_mounted"
  | "post_error";

export interface MountReport {
  expose_id: string;
  sticky_disk_key: string;
  setup_outcome: GuestSetupOutcome;
  // Empty when the commit was requested.
  skip_reason: SkipReason;
  was_formatted: boolean;
  format_ms: number;
  mount_ms: number;
  unmount_ms: number;
}

export interface MountReportTarget {
  agentAddr: string;
  metricsPort: number;
  vmId: string;
}

// Resolves the /internal endpoint from the environment; undefined when the
// runner has no metrics endpoint (nothing is sent).
export function mountReportTargetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MountReportTarget | undefined {
  const agentAddr = env.BLACKSMITH_AGENT_ADDR;
  const metricsPort = parseInt(env.BLACKSMITH_METRICS_HTTP_PORT || "", 10);
  if (!agentAddr || isNaN(metricsPort) || metricsPort <= 0) {
    return undefined;
  }
  return { agentAddr, metricsPort, vmId: env.BLACKSMITH_VM_ID || "" };
}

export function encodeMountReport(report: MountReport, vmId: string): string {
  return JSON.stringify({
    metric_type: MOUNT_REPORT_METRIC_TYPE,
    value: 1,
    vm_id: vmId,
    attributes: {},
    payload: report,
  });
}

export const MOUNT_REPORT_TIMEOUT_MS = 3000;

// Posts the report and swallows every failure: a missing endpoint, a refused
// connection or a slow agent only cost a debug line.
export async function sendMountReport(
  report: MountReport,
  target: MountReportTarget | undefined = mountReportTargetFromEnv(),
  timeoutMs: number = MOUNT_REPORT_TIMEOUT_MS,
): Promise<boolean> {
  if (!target) {
    core.debug(
      "[metrics] BLACKSMITH_AGENT_ADDR or BLACKSMITH_METRICS_HTTP_PORT not set, skipping mount report",
    );
    return false;
  }

  const body = encodeMountReport(report, target.vmId);
  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          hostname: target.agentAddr,
          port: target.metricsPort,
          path: "/internal",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("mount report request timed out"));
      });
      req.write(body);
      req.end();
    });
    core.debug(
      `[metrics] Reported sticky disk mount (setup=${report.setup_outcome}, skip=${report.skip_reason || "none"})`,
    );
    return true;
  } catch (error) {
    core.debug(
      `[metrics] Failed to report sticky disk mount: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// Parses a millisecond duration saved to GitHub Actions state; absent or
// malformed values report as 0.
export function parseStateMs(value: string): number {
  const ms = parseInt(value, 10);
  return isNaN(ms) || ms < 0 ? 0 : ms;
}
