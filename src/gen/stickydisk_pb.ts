// @generated from file stickydisk/v1/stickydisk.proto (package stickydisk.v1, syntax proto3)
// Local stubs replacing @buf/blacksmith_vm-agent.bufbuild_es

import { proto3 } from "@bufbuild/protobuf";

export const Architecture = proto3.makeEnum("stickydisk.v1.Architecture", [
  { no: 0, name: "ARCHITECTURE_UNSPECIFIED", localName: "UNSPECIFIED" },
  { no: 1, name: "ARCHITECTURE_AMD64", localName: "AMD64" },
  { no: 2, name: "ARCHITECTURE_ARM64", localName: "ARM64" },
]);

export const GetStickyDiskRequest = proto3.makeMessageType(
  "stickydisk.v1.GetStickyDiskRequest",
  () => [
    { no: 1, name: "sticky_disk_key", kind: "scalar", T: 9 /* STRING */ },
    { no: 2, name: "region", kind: "scalar", T: 9 /* STRING */ },
    {
      no: 3,
      name: "installation_model_id",
      kind: "scalar",
      T: 9 /* STRING */,
    },
    { no: 4, name: "vm_id", kind: "scalar", T: 9 /* STRING */ },
    { no: 5, name: "sticky_disk_type", kind: "scalar", T: 9 /* STRING */ },
    { no: 6, name: "repo_name", kind: "scalar", T: 9 /* STRING */ },
    { no: 7, name: "sticky_disk_token", kind: "scalar", T: 9 /* STRING */ },
  ],
);

export const GetStickyDiskResponse = proto3.makeMessageType(
  "stickydisk.v1.GetStickyDiskResponse",
  () => [
    { no: 1, name: "expose_id", kind: "scalar", T: 9 /* STRING */ },
    { no: 2, name: "disk_identifier", kind: "scalar", T: 9 /* STRING */ },
    {
      no: 3,
      name: "parent_snapshot_name",
      kind: "scalar",
      T: 9 /* STRING */,
    },
    { no: 4, name: "clone_name", kind: "scalar", T: 9 /* STRING */ },
  ],
);

export const CommitStickyDiskRequest = proto3.makeMessageType(
  "stickydisk.v1.CommitStickyDiskRequest",
  () => [
    { no: 1, name: "expose_id", kind: "scalar", T: 9 /* STRING */ },
    { no: 2, name: "sticky_disk_key", kind: "scalar", T: 9 /* STRING */ },
    { no: 3, name: "vm_id", kind: "scalar", T: 9 /* STRING */ },
    { no: 4, name: "should_commit", kind: "scalar", T: 8 /* BOOL */ },
    { no: 5, name: "repo_name", kind: "scalar", T: 9 /* STRING */ },
    { no: 6, name: "sticky_disk_token", kind: "scalar", T: 9 /* STRING */ },
    { no: 7, name: "fs_disk_usage_bytes", kind: "scalar", T: 3 /* INT64 */ },
  ],
);

export const CommitStickyDiskResponse = proto3.makeMessageType(
  "stickydisk.v1.CommitStickyDiskResponse",
  [],
);

export const Metric_MetricType = proto3.makeEnum(
  "stickydisk.v1.Metric.MetricType",
  [
    { no: 0, name: "METRIC_TYPE_UNSPECIFIED" },
    { no: 1, name: "METRIC_TYPE_GAUGE" },
    { no: 2, name: "METRIC_TYPE_TIMER" },
    { no: 3, name: "METRIC_TYPE_CACHE_HIT" },
    { no: 4, name: "METRIC_TYPE_CACHE_MISS" },
    { no: 5, name: "METRIC_TYPE_CACHE_RESTORE_FAILURE" },
    { no: 6, name: "METRIC_TYPE_CACHE_SAVE_FAILURE" },
    { no: 7, name: "METRIC_TYPE_STICKY_DISK_HIT" },
    { no: 8, name: "METRIC_TYPE_STICKY_DISK_MISS" },
  ],
);

export const Metric = proto3.makeMessageType("stickydisk.v1.Metric", () => [
  {
    no: 1,
    name: "int_value",
    kind: "scalar",
    T: 3 /* INT64 */,
    oneof: "value",
  },
  {
    no: 2,
    name: "double_value",
    kind: "scalar",
    T: 1 /* DOUBLE */,
    oneof: "value",
  },
  {
    no: 3,
    name: "type",
    kind: "enum",
    T: proto3.getEnumType(Metric_MetricType),
  },
]);

export const ReportMetricRequest = proto3.makeMessageType(
  "stickydisk.v1.ReportMetricRequest",
  () => [
    { no: 1, name: "repo_name", kind: "scalar", T: 9 /* STRING */ },
    { no: 2, name: "region", kind: "scalar", T: 9 /* STRING */ },
    { no: 3, name: "metric", kind: "message", T: Metric },
  ],
);

export const ReportMetricResponse = proto3.makeMessageType(
  "stickydisk.v1.ReportMetricResponse",
  [],
);

export const UpRequest = proto3.makeMessageType("stickydisk.v1.UpRequest", []);

export const UpResponse = proto3.makeMessageType(
  "stickydisk.v1.UpResponse",
  [],
);

export const QueueDockerJobRequest = proto3.makeMessageType(
  "stickydisk.v1.QueueDockerJobRequest",
  () => [
    { no: 1, name: "job_name", kind: "scalar", T: 9 /* STRING */ },
    { no: 2, name: "tailscale_hostname", kind: "scalar", T: 9 /* STRING */ },
    { no: 3, name: "vm_id", kind: "scalar", T: 9 /* STRING */ },
    { no: 4, name: "arch", kind: "enum", T: proto3.getEnumType(Architecture) },
  ],
);

export const QueueDockerJobResponse = proto3.makeMessageType(
  "stickydisk.v1.QueueDockerJobResponse",
  [],
);
