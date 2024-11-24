import { getInput, setFailed, info } from "@actions/core";
import fetch from "node-fetch";

async function run(): Promise<void> {
  try {
    const cacheKey = getInput("key", { required: true });
    const cacheVersion = getInput("version"); // optional

    const baseUrl =
      process.env.BLACKSMITH_CACHE_URL ||
      (process.env.PETNAME?.includes("staging")
        ? "https://stagingapi.blacksmith.sh/cache"
        : "https://api.blacksmith.sh/cache");

    const resource = cacheVersion ? `${cacheKey}/${cacheVersion}` : cacheKey;
    const url = `${baseUrl}/caches/${resource}`;

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Accept: "application/json; version=6.0-preview.1",
        "X-GitHub-Repo-Name": process.env["GITHUB_REPO_NAME"] ?? "",
        Authorization: `Bearer ${process.env["BLACKSMITH_CACHE_TOKEN"]}`,
        "X-Cache-Region": process.env["BLACKSMITH_REGION"] ?? "eu-central",
      },
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Failed to delete cache: ${response.status} ${response.statusText}`
      );
    }

    if (response.status === 404) {
      info(
        `Cache not found: ${cacheKey}${cacheVersion ? `@${cacheVersion}` : ""}`
      );
    } else {
      info(
        `Successfully deleted cache${cacheVersion ? " version" : ""}: ${cacheKey}${cacheVersion ? `@${cacheVersion}` : ""}`
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      setFailed(error.message);
    } else {
      setFailed("An unexpected error occurred");
    }
  }
}

run();
