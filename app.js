/**
 * @file app.js
 * @description Dynamic detection and registry for sub-applications.
 * Uses caching and throttling to eliminate redundant synchronous disk I/O.
 */

const fs = require("fs");
const path = require("path");
const config = require("./config");
const App = require("./app-base");
const PythonApp = require("./app-types/python");
const NodeApp = require("./app-types/node");
const StaticApp = require("./app-types/static");

// Polymorphic detection based on directory file structure
App.create = function (name, fullPath) {
    // Python application detection
    if (fs.existsSync(path.join(fullPath, "app.py"))) {
        return new PythonApp(name, fullPath);
    }

    // Node.js application detection
    if (
        fs.existsSync(path.join(fullPath, "package.json")) ||
        fs.existsSync(path.join(fullPath, "server", "package.json"))
    ) {
        return new NodeApp(name, fullPath);
    }

    // Static HTML application detection
    if (fs.existsSync(path.join(fullPath, "index.html"))) {
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

function refreshKnownApps(force = false) {
    const now = Date.now();
    if (!force && now - lastRefreshTime < REFRESH_THROTTLE_MS) {
        // Skip redundant disk reads on high traffic
        return;
    }
    lastRefreshTime = now;

    if (!fs.existsSync(config.BASE_DIR)) {
        return;
    }

    try {
        const entries = fs.readdirSync(config.BASE_DIR, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const folderName = entry.name;

            if (folderName.startsWith(".") || IGNORED_DIRS.has(folderName)) {
                continue;
            }

            if (!config.apps.has(folderName)) {
                const fullPath = path.join(config.BASE_DIR, folderName);
                try {
                    const appInstance = App.create(folderName, fullPath);
                    config.apps.set(folderName, appInstance);
                    console.log(`[PROXY] Detected and registered application: ${folderName} (${appInstance.type})`);
                } catch (err) {
                    // Unrecognized folder ignored silently
                }
            }
        }
    } catch (err) {
        console.error(`[PROXY ERROR] Failed scanning ${config.BASE_DIR}: ${err.message}`);
    }
}

module.exports = {
    App,
    PythonApp,
    NodeApp,
    StaticApp,
    refreshKnownApps,
};
