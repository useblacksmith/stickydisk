import fsPromises from 'node:fs/promises';
import 'node:fs';
import os from 'node:os';
import 'node:path';

/**
 * Retrieves the value of a GitHub Actions input.
 *
 * @param name - The name of the GitHub Actions input.
 * @returns The value of the GitHub Actions input, or an empty string if not found.
 */
function getInput(name) {
    const value = process.env[`INPUT_${name.toUpperCase()}`] ?? "";
    return value.trim();
}

/**
 * Logs an error message in GitHub Actions.
 *
 * @param err - The error, which can be of any type.
 */
function logError(err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`::error::${message}${os.EOL}`);
}

try {
    const path = getInput("path");
    await fsPromises.mkdir(path, { recursive: true });
}
catch (err) {
    logError(err);
    process.exitCode = 1;
}
