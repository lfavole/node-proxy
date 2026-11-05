/**
 * @file app-types/node.js
 * @description Gestion complète de l'installation, du build et du démarrage des sous-applications Node.js.
 */

const fs = require("fs");
const path = require("path");

const App = require("../app-base");

class NodeApp extends App {
    constructor(name, fullPath) {
        super(name, fullPath);
        // Typage applicatif explicite
        this.type = "node";
    }

    /**
     * Détermine dynamiquement le chemin de travail (CWD) selon l'emplacement de package.json.
     */
    _resolveNodePaths() {
        let cwd = this.path;
        let pkgPath = path.join(this.path, "package.json");

        if (!fs.existsSync(pkgPath)) {
            pkgPath = path.join(this.path, "server", "package.json");
            // Support des structures imbriquées de type /server
            cwd = path.join(this.path, "server");
        }
        return { cwd, pkgPath };
    }

    /**
     * Lance l'application Node.js via le script npm approprié.
     */
    async startApp() {
        const { cwd, pkgPath } = this._resolveNodePaths();

        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        let command = "npm";
        // Utilisation prioritaire du script de production
        let args = (pkg.scripts?.prod) ? ["run", "prod"] : ["run", "start"];

        // Exécution unifiée
        return await this.executeServiceCommand(command, args, {});
    }

    /**
     * Installe les modules Node et exécute les routines de bundling (Webpack, Vite, etc.) si présentes.
     */
    async buildApp() {
        const { cwd, pkgPath } = this._resolveNodePaths();

        console.log(`[BUILD] Installing Node dependencies in ${cwd}...`);
        if (!(await this.runBuildCommand("npm", ["install"], { cwd, shell: true }))) {
            console.error(`[BUILD] Failed to install dependencies for ${this.name}`);
            return false;
        }

        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.scripts) {
            for (const scriptName of Object.keys(pkg.scripts)) {
                // Déclenche tous les scripts préfixés par "build" (ex: build, build:prod)
                if (scriptName.match(/^build\b/)) {
                    console.log(`[BUILD] Executing script: npm run ${scriptName} in ${cwd}`);
                    await this.runBuildCommand("npm", ["run", scriptName], { cwd, shell: true });
                }
            }
        }
        return true;
    }
}

module.exports = NodeApp;
