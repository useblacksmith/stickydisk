import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { deleteCache } from "../main";
import fetch, { Response } from "node-fetch";
import { info } from "@actions/core";

jest.mock("node-fetch");
jest.mock("@actions/core", () => ({
  info: jest.fn(),
  setFailed: jest.fn(),
  getInput: jest.fn(),
}));

const mockedFetch = jest.mocked(fetch);
const mockedInfo = jest.mocked(info);

describe("deleteCache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);
  });

  const defaultParams = {
    baseUrl: "https://api.blacksmith.sh/cache",
    repoName: "test-repo",
    cacheToken: "test-token",
    region: "eu-central",
  };

  it("should send DELETE request for a specific cache key", async () => {
    await deleteCache({
      cacheKey: "npm-cache",
      ...defaultParams,
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      "https://api.blacksmith.sh/cache/caches/npm-cache",
      {
        method: "DELETE",
        headers: {
          Accept: "application/json; version=6.0-preview.1",
          "X-GitHub-Repo-Name": "test-repo",
          Authorization: "Bearer test-token",
          "X-Cache-Region": "eu-central",
        },
      }
    );
    expect(mockedInfo).toHaveBeenCalledWith(
      "Successfully deleted cache: npm-cache"
    );
  });

  it("should send DELETE request for a specific cache version", async () => {
    await deleteCache({
      cacheKey: "npm-cache",
      cacheVersion: "v1.0",
      ...defaultParams,
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      "https://api.blacksmith.sh/cache/caches/npm-cache/v1.0",
      {
        method: "DELETE",
        headers: {
          Accept: "application/json; version=6.0-preview.1",
          "X-GitHub-Repo-Name": "test-repo",
          Authorization: "Bearer test-token",
          "X-Cache-Region": "eu-central",
        },
      }
    );
    expect(mockedInfo).toHaveBeenCalledWith(
      "Successfully deleted cache version: npm-cache@v1.0"
    );
  });

  it("should send DELETE request with prefix parameter", async () => {
    await deleteCache({
      cacheKey: "npm-",
      prefix: true,
      ...defaultParams,
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      "https://api.blacksmith.sh/cache/caches/npm-?prefix",
      {
        method: "DELETE",
        headers: {
          Accept: "application/json; version=6.0-preview.1",
          "X-GitHub-Repo-Name": "test-repo",
          Authorization: "Bearer test-token",
          "X-Cache-Region": "eu-central",
        },
      }
    );
    expect(mockedInfo).toHaveBeenCalledWith("Successfully deleted cache: npm-");
  });

  it("should send DELETE request with empty key and prefix parameter", async () => {
    await deleteCache({
      cacheKey: "",
      prefix: true,
      ...defaultParams,
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      "https://api.blacksmith.sh/cache/caches/?prefix",
      {
        method: "DELETE",
        headers: {
          Accept: "application/json; version=6.0-preview.1",
          "X-GitHub-Repo-Name": "test-repo",
          Authorization: "Bearer test-token",
          "X-Cache-Region": "eu-central",
        },
      }
    );
    expect(mockedInfo).toHaveBeenCalledWith("Successfully deleted cache: ");
  });

  it("should handle 404 response", async () => {
    mockedFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    await deleteCache({
      cacheKey: "non-existent",
      ...defaultParams,
    });

    expect(mockedInfo).toHaveBeenCalledWith("Cache not found: non-existent");
  });

  it("should throw error for non-404 failure", async () => {
    mockedFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);

    await expect(
      deleteCache({
        cacheKey: "npm-cache",
        ...defaultParams,
      })
    ).rejects.toThrow("Failed to delete cache: 500 Internal Server Error");
  });

  it("should fail if key is empty and prefix is not true", async () => {
    await expect(
      deleteCache({
        cacheKey: "",
        prefix: false,
        ...defaultParams,
      })
    ).rejects.toThrow("Cache key cannot be empty unless prefix is true");
  });
});
