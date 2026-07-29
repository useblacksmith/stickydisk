import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { StickyDiskService } from "@buf/blacksmith_vm-agent.connectrpc_es/stickydisk/v1/stickydisk_connect";
import * as core from "@actions/core";

export function getAgentAddr(): string | undefined {
  return process.env.BLACKSMITH_AGENT_ADDR || undefined;
}

export function getAgentEndpoint(): string | undefined {
  const addr = getAgentAddr();
  const port = process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT;
  if (!addr || !port) {
    return undefined;
  }
  return `${addr}:${port}`;
}

export function createStickyDiskClient() {
  const endpoint = getAgentEndpoint();
  if (!endpoint) {
    throw new Error(
      "BLACKSMITH_AGENT_ADDR or BLACKSMITH_STICKY_DISK_GRPC_PORT is not set; cannot dial the Blacksmith agent",
    );
  }
  core.info(`Creating sticky disk client for ${endpoint}`);
  const transport = createGrpcTransport({
    baseUrl: `http://${endpoint}`,
    httpVersion: "2",
  });

  return createClient(StickyDiskService, transport);
}
