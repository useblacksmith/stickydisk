import { getInput, setFailed, info } from "@actions/core";
import fetch from "node-fetch";

interface DeleteCacheParams {
  cacheKey: string;
  cacheVersion?: string;
  prefix?: boolean;
  baseUrl?: string;
  repoName?: string;
  cacheToken?: string;
  region?: string;
}

export async function deleteCache({
  cacheKey,
  cacheVersion,
  prefix = false,
  baseUrl = process.env.BLACKSMITH_CACHE_URL ||
    (process.env.PETNAME?.includes("staging")
      ? "https://stagingapi.blacksmith.sh/cache"
      : "https://api.blacksmith.sh/cache"),
  repoName = process.env["GITHUB_REPO_NAME"] ?? "",
  cacheToken = process.env["BLACKSMITH_CACHE_TOKEN"],
  region = process.env["BLACKSMITH_REGION"] ?? "eu-central",
}: DeleteCacheParams): Promise<void> {
  if (!cacheKey && !prefix) {
    throw new Error("Cache key cannot be empty unless prefix is true");
  }
  if (cacheVersion && !cacheKey) {
    throw new Error("Cannot specify version when using empty key");
  }
  if (prefix && cacheVersion) {
    throw new Error("Cannot specify version when using prefix");
  }

  const resource = cacheVersion ? `${cacheKey}/${cacheVersion}` : cacheKey;
  const url = `${baseUrl}/caches/${resource}`;

  const response = await fetch(prefix ? `${url}?prefix` : url, {
    method: "DELETE",
    headers: {
      Accept: "application/json; version=6.0-preview.1",
      "X-GitHub-Repo-Name": repoName,
      Authorization: `Bearer ${cacheToken}`,
      "X-Cache-Region": region,
    },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Failed to delete cache: ${response.status} ${response.statusText}`
    );
  }

  if (response.status === 404) {
    info(
      `Cache not found${cacheKey ? `: ${cacheKey}` : ""}${cacheVersion ? `@${cacheVersion}` : ""}`
    );
  } else {
    const data = await response.json();
    info(
      `Successfully deleted ${prefix ? "caches with prefix" : "cache"}${
        cacheVersion ? " version" : ""
      }: ${cacheKey}${cacheVersion ? `@${cacheVersion}` : ""}`
    );
    if (data.deleted !== undefined) {
      info(`Deleted ${data.deleted} cache entries`);
    }
  }
}

async function run(): Promise<void> {
  try {
    const cacheKey = getInput("key");
    const cacheVersion = getInput("version");
    const prefix = getInput("prefix") === "true";

    await deleteCache({ cacheKey, cacheVersion, prefix });
  } catch (error) {
    if (error instanceof Error) {
      setFailed(error.message);
    } else {
      setFailed("An unexpected error occurred");
    }
  }
}

run();
