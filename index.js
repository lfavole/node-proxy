/**
 * @file index.js
 * @description Point d'entrée principal unique de l'architecture proxy/build.
 * Détermine le contexte d'exécution via les arguments d'appel.
 */

// Sélection du contexte d'exécution principal
if (process.argv.includes("--build")) {
    const { performBuild } = require("./build");

    // Mode Compilateur / Build système
    performBuild().then(() => process.exit(0)).catch((err) => {
        console.error("[CRITICAL BUILD ERROR]", err);
        process.exit(1);
    });

} else {
    const { startServer } = require("./server");

    // Mode Serveur HTTP Reverse Proxy Standard
    startServer();
}
