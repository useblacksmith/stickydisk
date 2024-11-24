'use strict';

var core = require('@actions/core');
var fetch = require('node-fetch');

async function run() {
    var _a, _b, _c;
    try {
        const cacheKey = core.getInput("key", { required: true });
        const cacheVersion = core.getInput("version"); // optional
        const baseUrl = process.env.BLACKSMITH_CACHE_URL ||
            (((_a = process.env.PETNAME) === null || _a === void 0 ? void 0 : _a.includes("staging"))
                ? "https://stagingapi.blacksmith.sh/cache"
                : "https://api.blacksmith.sh/cache");
        const resource = cacheVersion ? `${cacheKey}/${cacheVersion}` : cacheKey;
        const url = `${baseUrl}/${resource}`;
        const response = await fetch(url, {
            method: "DELETE",
            headers: {
                Accept: "application/json; version=6.0-preview.1",
                "X-Github-Repo-Name": (_b = process.env["GITHUB_REPO_NAME"]) !== null && _b !== void 0 ? _b : "",
                Authorization: `Bearer ${process.env["BLACKSMITH_CACHE_TOKEN"]}`,
                "X-Cache-Region": (_c = process.env["BLACKSMITH_REGION"]) !== null && _c !== void 0 ? _c : "eu-central",
            },
        });
        if (!response.ok && response.status !== 404) {
            throw new Error(`Failed to delete cache: ${response.status} ${response.statusText}`);
        }
        if (response.status === 404) {
            core.info(`Cache not found: ${cacheKey}${cacheVersion ? `@${cacheVersion}` : ""}`);
        }
        else {
            core.info(`Successfully deleted cache${cacheVersion ? " version" : ""}: ${cacheKey}${cacheVersion ? `@${cacheVersion}` : ""}`);
        }
    }
    catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message);
        }
        else {
            core.setFailed("An unexpected error occurred");
        }
    }
}
run();
//# sourceMappingURL=index.cjs.map
