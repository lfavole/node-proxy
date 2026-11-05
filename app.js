/**
 * @file app.js
 * @description Pivot de détection et registre des sous-applications chargées dynamiquement.
 */

const fs = require("fs");
const path = require("path");

const config = require("./config");
const App = require("./app-base");
const PythonApp = require("./app-types/python");
const NodeApp = require("./app-types/node");
const StaticApp = require("./app-types/static");

/**
 * Analyse le système de fichiers pour instancier la bonne sous-classe ou lever une erreur.
 */
App.create = function(name, fullPath) {
    // Détection d'une structure Python
    if (fs.existsSync(path.join(fullPath, "app.py"))) {
        return new PythonApp(name, fullPath);
    }
    // Détection d'une structure Node.js
    if (fs.existsSync(path.join(fullPath, "package.json")) || fs.existsSync(path.join(fullPath, "server", "package.json"))) {
        return new NodeApp(name, fullPath);
    }
    // Détection d'une structure Statique pure
    if (fs.existsSync(path.join(fullPath, "index.html"))) {
        return new StaticApp(name, fullPath);
    }

    throw new Error(`Type d'application inconnu pour le dossier : ${name}`);
};

/**
 * Parcourt le répertoire pour mettre à jour la liste des applications connues.
 */
function refreshKnownApps() {
    const files = fs.readdirSync(config.BASE_DIR);

    for (const file of files) {
        if (file.startsWith(".") || file == "node_modules" || file == "logs" || file == "proxy") continue;

        const fullPath = path.join(config.BASE_DIR, file);
        if (!fs.statSync(fullPath).isDirectory()) continue;  // Filtre uniquement les dossiers d'applications

        if (!config.apps.has(file)) {
            try {
                const appInstance = App.create(file, fullPath);  // Détection polymorphique
                config.apps.set(file, appInstance);  // Enregistrement dans la Map globale
            } catch (err) {
                console.error(`[PROXY ERROR] ${err.message}`);
            }
        }
    }
}

module.exports = { App, PythonApp, NodeApp, StaticApp, refreshKnownApps };
