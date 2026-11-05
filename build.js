/**
 * @file build.js
 * @description Script d'orchestration pour le build automatisé et isolé de chaque application.
 */

const config = require("./config");
const { refreshKnownApps } = require("./app");

/**
 * Orchestrateur principal exécutant la routine de build dédiée de chaque sous-application détectée.
 */
async function performBuild() {
    console.log("[BUILD] Starting compile and build process...");
    // Analyse du répertoire pour rafraîchir les applications existantes
    refreshKnownApps();

    for (const [name, app] of config.apps.entries()) {
        console.log(`\n[BUILD] Checking application: ${name} (${app.type})`);

        // Déclenchement de la méthode de build polymorphique encapsulée dans chaque entité app-type
        const success = await app.buildApp();
        if (!success) {
            console.error(`[BUILD] Compilation aborted or encountered errors for application: ${name}`);
        }
    }
    console.log("\n[BUILD] Build process complete.");
}

module.exports = { performBuild };
