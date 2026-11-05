/**
 * @file build.js
 * @description Orchestration script for automated building and dependency installation.
 */

const config = require("./config");
const { refreshKnownApps } = require("./app");

/**
 * Main build orchestrator running the polymorphic build routine of each detected application.
 */
async function performBuild() {
    console.log("[BUILD] Starting compile and build process...");
    // Refresh known applications list with forced scan
    refreshKnownApps(true);

    for (const [name, app] of config.apps.entries()) {
        console.log(`\n[BUILD] Checking application: ${name} (${app.type})`);

        // Trigger polymorphic build step
        const success = await app.buildApp();
        if (!success) {
            console.error(`[BUILD] Compilation aborted or encountered errors for application: ${name}`);
        }
    }
    console.log("\n[BUILD] Build process complete.");
}

module.exports = {
    performBuild,
};
