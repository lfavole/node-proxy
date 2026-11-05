/**
 * @file app-types/python.js
 * @description Implémentation complète de la gestion du cycle de vie des applications Python.
 */

const fs = require("fs");
const path = require("path");

const App = require("../app-base");

class PythonApp extends App {
    constructor(name, fullPath) {
        super(name, fullPath);
        // Typage applicatif explicite
        this.type = "python";
    }

    /**
     * Logique de démarrage de l'infrastructure de service Python.
     */
    async startApp() {
        // Interpréteur global par défaut
        let command = "python3";
        let args = ["app.py"];

        const localVenvPython = path.join(this.path, ".venv", "bin", "python3");
        if (fs.existsSync(localVenvPython)) {
            // Redirection automatique vers l'interpréteur de l'environnement virtuel isolé
            command = localVenvPython;
        }

        // Délégation du démarrage à la classe parente
        return await this.executeServiceCommand(command, args, {});
    }

    /**
     * Logique d'orchestration de compilation et d'installation pour Python.
     */
    async buildApp() {
        console.log(`[BUILD] Configuring Python Virtual Environment in ${this.path}...`);
        const venvArgs = ["-m", "venv", ".venv", "--without-pip"];

        if (!(await this.runBuildCommand("python3", venvArgs, { cwd: this.path }))) {
            console.error(`[BUILD] Failed to create virtual environment for ${this.name}`);
            return false;
        }

        if (!(await this.runBuildCommand("curl", ["-sS", "https://bootstrap.pypa.io/get-pip.py"], { cwd: this.path })))
            return false;

        // Concaténation des commandes bash pour injecter pip de manière isolée et installer les modules requis
        const installPipCommand = (
            "source .venv/bin/activate "
            + "&& (curl -sS https://bootstrap.pypa.io/get-pip.py | python) "
            + "&& pip install -r requirements.txt"
        );
        console.log(`[BUILD] Installing pip and requirements for ${this.name}...`);
        return await this.runBuildCommand("bash", ["-c", installPipCommand], { cwd: this.path });
    }
}

module.exports = PythonApp;
