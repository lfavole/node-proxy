/**
 * @file app-types/python.js
 * @description Python sub-application lifecycle manager (Flask, FastAPI, WSGI, HTTP).
 * Fully asynchronous file system checks.
 */

const fs = require("fs").promises;
const path = require("path");
const App = require("../app-base");

/**
 * Asynchronously checks if a file exists without blocking.
 */
async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

class PythonApp extends App {
    constructor(name, fullPath) {
        super(name, fullPath);
        this.type = "python";
    }

    async startApp() {
        let command = "python3";
        const args = [
            "app.py",
        ];

        const venvPython = path.join(this.path, ".venv", "bin", "python3");
        const venvPythonAlt = path.join(this.path, ".venv", "bin", "python");

        if (await fileExists(venvPython)) {
            command = venvPython;
        } else if (await fileExists(venvPythonAlt)) {
            command = venvPythonAlt;
        }

        // PYTHONUNBUFFERED=1 ensures real-time logging output without stream buffering
        return await this.executeServiceCommand(
            command,
            args,
            {
                PYTHONUNBUFFERED: "1",
            },
        );
    }

    async buildApp() {
        console.log(`[BUILD] Setting up Python virtual environment in ${this.path}...`);
        const venvDir = path.join(this.path, ".venv");

        if (!(await fileExists(venvDir))) {
            const venvArgs = [
                "-m",
                "venv",
                ".venv",
            ];
            const created = await this.runBuildCommand(
                "python3",
                venvArgs,
                {
                    cwd: this.path,
                },
            );
            if (!created) {
                console.error(`[BUILD] Virtual environment setup failed for ${this.name}`);
                return false;
            }
        }

        const reqsPath = path.join(this.path, "requirements.txt");
        if (await fileExists(reqsPath)) {
            console.log(`[BUILD] Installing requirements for ${this.name}...`);
            const installCmd = "source .venv/bin/activate && pip install -r requirements.txt";
            return await this.runBuildCommand(
                "bash",
                [
                    "-c",
                    installCmd,
                ],
                {
                    cwd: this.path,
                },
            );
        }

        return true;
    }
}

module.exports = PythonApp;
