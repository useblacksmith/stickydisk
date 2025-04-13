import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { StickyDiskService } from "@buf/blacksmith_vm-agent.connectrpc_es/stickydisk/v1/stickydisk_connect";

export function createStickyDiskClient() {
  const port = process.env.BLACKSMITH_STICKY_DISK_GRPC_PORT || "5557";
  const transport = createGrpcTransport({
    baseUrl: `http://192.168.127.1:${port}`,
    httpVersion: "2",
  });

  return createClient(StickyDiskService, transport);
}
