/**
 * @file app.js
 * @description Fully asynchronous dynamic detector and registry for sub-applications.
 * Eliminates all synchronous file system calls to prevent event loop blocking on slow disks.
 */

const fs = require("fs").promises;
const path = require("path");
const config = require("./config");
const App = require("./app-base");
const PythonApp = require("./app-types/python");
const NodeApp = require("./app-types/node");
const StaticApp = require("./app-types/static");

/**
 * Asynchronously checks if a file or directory exists without blocking.
 */
async function fileExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

// Polymorphic async detection based on directory file structure
App.create = async function (name, fullPath) {
    // Check for Python application
    if (await fileExists(path.join(fullPath, "app.py"))) {
        return new PythonApp(name, fullPath);
    }

    // Check for Node.js application
    if (
        (await fileExists(path.join(fullPath, "package.json"))) ||
        (await fileExists(path.join(fullPath, "server", "package.json")))
    ) {
        return new NodeApp(name, fullPath);
    }

    // Check for Static HTML application
    if (await fileExists(path.join(fullPath, "index.html"))) {
        return new StaticApp(name, fullPath);
    }

    throw new Error(`Unknown application type for folder: ${name}`);
};

// Reserved directories to ignore during scan
const IGNORED_DIRS = new Set([
    "node_modules",
    "logs",
    "proxy",
    "node-proxy",
    "dist",
    "src",
    ".git",
    ".venv",
    "coverage",
]);

let lastRefreshTime = 0;
// Scan cooldown: at most once every 3 seconds
const REFRESH_THROTTLE_MS = 3000;
let isRefreshing = false;

async function refreshKnownApps(force = false) {
    const now = Date.now();
    if (!force && now - lastRefreshTime < REFRESH_THROTTLE_MS) {
        // Skip redundant disk reads on high traffic
        return;
    }
    if (isRefreshing) {
        return;
    }
    isRefreshing = true;
    lastRefreshTime = now;

    try {
        if (!(await fileExists(config.BASE_DIR))) {
            return;
        }

        const entries = await fs.readdir(config.BASE_DIR, {
            withFileTypes: true,
        });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const folderName = entry.name;

            if (folderName.startsWith(".") || IGNORED_DIRS.has(folderName)) {
                continue;
            }

            if (!config.apps.has(folderName)) {
                const fullPath = path.join(config.BASE_DIR, folderName);
                try {
                    const appInstance = await App.create(folderName, fullPath);
                    config.apps.set(folderName, appInstance);
                    console.log(`[PROXY] Detected and registered application: ${folderName} (${appInstance.type})`);
                } catch (err) {
                    // Unrecognized folder ignored silently
                }
            }
        }
    } catch (err) {
        console.error(`[PROXY ERROR] Failed scanning ${config.BASE_DIR}: ${err.message}`);
    } finally {
        isRefreshing = false;
    }
}

module.exports = {
    App,
    PythonApp,
    NodeApp,
    StaticApp,
    refreshKnownApps,
    fileExists,
};
