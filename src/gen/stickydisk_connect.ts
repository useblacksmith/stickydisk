// @generated from file stickydisk/v1/stickydisk.proto (package stickydisk.v1, syntax proto3)
// Local stubs replacing @buf/blacksmith_vm-agent.connectrpc_es

import { MethodKind } from "@bufbuild/protobuf";
import {
  GetStickyDiskRequest,
  GetStickyDiskResponse,
  CommitStickyDiskRequest,
  CommitStickyDiskResponse,
  UpRequest,
  UpResponse,
  ReportMetricRequest,
  ReportMetricResponse,
  QueueDockerJobRequest,
  QueueDockerJobResponse,
} from "./stickydisk_pb";

export const StickyDiskService = {
  typeName: "stickydisk.v1.StickyDiskService",
  methods: {
    getStickyDisk: {
      name: "GetStickyDisk",
      I: GetStickyDiskRequest,
      O: GetStickyDiskResponse,
      kind: MethodKind.Unary,
    },
    commitStickyDisk: {
      name: "CommitStickyDisk",
      I: CommitStickyDiskRequest,
      O: CommitStickyDiskResponse,
      kind: MethodKind.Unary,
    },
    up: {
      name: "Up",
      I: UpRequest,
      O: UpResponse,
      kind: MethodKind.Unary,
    },
    reportMetric: {
      name: "ReportMetric",
      I: ReportMetricRequest,
      O: ReportMetricResponse,
      kind: MethodKind.Unary,
    },
    queueDockerJob: {
      name: "QueueDockerJob",
      I: QueueDockerJobRequest,
      O: QueueDockerJobResponse,
      kind: MethodKind.Unary,
    },
  },
} as const;
