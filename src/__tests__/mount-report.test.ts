import * as http from "http";
import { AddressInfo } from "net";
import {
  MOUNT_REPORT_METRIC_TYPE,
  MountReport,
  encodeMountReport,
  mountReportTargetFromEnv,
  parseStateMs,
  sendMountReport,
} from "../mount-report";

const report: MountReport = {
  expose_id: "expose-1",
  sticky_disk_key: "node-modules",
  setup_outcome: "mounted",
  skip_reason: "on_change_unchanged",
  was_formatted: true,
  format_ms: 900,
  mount_ms: 25,
  unmount_ms: 130,
};

interface Received {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
  body: string;
}

function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe("mountReportTargetFromEnv", () => {
  it("returns undefined without an agent address", () => {
    expect(
      mountReportTargetFromEnv({ BLACKSMITH_METRICS_HTTP_PORT: "8080" }),
    ).toBeUndefined();
  });

  it("returns undefined without a metrics port", () => {
    expect(
      mountReportTargetFromEnv({ BLACKSMITH_AGENT_ADDR: "192.0.2.1" }),
    ).toBeUndefined();
    expect(
      mountReportTargetFromEnv({
        BLACKSMITH_AGENT_ADDR: "192.0.2.1",
        BLACKSMITH_METRICS_HTTP_PORT: "nope",
      }),
    ).toBeUndefined();
  });

  it("reads the address, port and vm id", () => {
    expect(
      mountReportTargetFromEnv({
        BLACKSMITH_AGENT_ADDR: "192.0.2.1",
        BLACKSMITH_METRICS_HTTP_PORT: "8080",
        BLACKSMITH_VM_ID: "vm-1",
      }),
    ).toEqual({ agentAddr: "192.0.2.1", metricsPort: 8080, vmId: "vm-1" });
  });
});

describe("encodeMountReport", () => {
  it("wraps the report in the /internal envelope", () => {
    expect(JSON.parse(encodeMountReport(report, "vm-1"))).toEqual({
      metric_type: MOUNT_REPORT_METRIC_TYPE,
      value: 1,
      vm_id: "vm-1",
      attributes: {},
      payload: report,
    });
  });
});

describe("parseStateMs", () => {
  it("parses saved durations and folds missing or bad values to 0", () => {
    expect(parseStateMs("1234")).toBe(1234);
    expect(parseStateMs("")).toBe(0);
    expect(parseStateMs("-5")).toBe(0);
    expect(parseStateMs("abc")).toBe(0);
  });
});

describe("sendMountReport", () => {
  it("posts the envelope to /internal", async () => {
    let received: Received | undefined;
    const { server, port } = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received = {
          method: req.method,
          url: req.url,
          contentType: req.headers["content-type"],
          body,
        };
        res.writeHead(200).end("ok");
      });
    });
    try {
      await expect(
        sendMountReport(report, {
          agentAddr: "127.0.0.1",
          metricsPort: port,
          vmId: "vm-1",
        }),
      ).resolves.toBe(true);
    } finally {
      await close(server);
    }
    expect(received).toBeDefined();
    expect(received?.method).toBe("POST");
    expect(received?.url).toBe("/internal");
    expect(received?.contentType).toBe("application/json");
    expect(JSON.parse(received?.body ?? "")).toEqual(
      JSON.parse(encodeMountReport(report, "vm-1")),
    );
  });

  it("does nothing without a target", async () => {
    await expect(sendMountReport(report, undefined)).resolves.toBe(false);
  });

  it("swallows a refused connection", async () => {
    const { server, port } = await listen(() => undefined);
    await close(server);
    await expect(
      sendMountReport(report, {
        agentAddr: "127.0.0.1",
        metricsPort: port,
        vmId: "vm-1",
      }),
    ).resolves.toBe(false);
  });

  it("gives up on a silent agent after the timeout", async () => {
    const { server } = await listen(() => {
      // Never answer.
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const started = Date.now();
      await expect(
        sendMountReport(
          report,
          { agentAddr: "127.0.0.1", metricsPort: port, vmId: "vm-1" },
          200,
        ),
      ).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await close(server);
    }
  });
});
