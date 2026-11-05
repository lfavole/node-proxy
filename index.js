/**
 * @file index.js
 * @description Single main entry point for the proxy and build architecture.
 * Determines the execution context via command-line arguments.
 */

// Check execution context
if (process.argv.includes("--build")) {
    const { performBuild } = require("./build");
    // System compilation and build mode
    performBuild()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error("[CRITICAL BUILD ERROR]", err);
            process.exit(1);
        });
} else {
    const { startServer } = require("./server");
    // Standard HTTP reverse proxy mode
    startServer();
}
