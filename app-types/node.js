/**
 * @file app-types/node.js
 * @description Node.js sub-application lifecycle manager supporting root and /server structures.
 */

const fs = require("fs");
const path = require("path");
const App = require("../app-base");

class NodeApp extends App {
    constructor(name, fullPath) {
        super(name, fullPath);
        this.type = "node";
    }

    _resolveNodePaths() {
        let cwd = this.path;
        let pkgPath = path.join(this.path, "package.json");

        if (!fs.existsSync(pkgPath)) {
            const nestedPkg = path.join(this.path, "server", "package.json");
            if (fs.existsSync(nestedPkg)) {
                pkgPath = nestedPkg;
                cwd = path.join(this.path, "server");
            }
        }
        return {
            cwd,
            pkgPath,
        };
    }

    async startApp() {
        const { cwd, pkgPath } = this._resolveNodePaths();
        let command = "npm";
        let args = [
            "run",
            "start",
        ];

        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
                if (pkg.scripts?.prod) {
                    args = [
                        "run",
                        "prod",
                    ];
                } else if (pkg.scripts?.start) {
                    args = [
                        "run",
                        "start",
                    ];
                } else if (pkg.main) {
                    command = "node";
                    args = [
                        pkg.main,
                    ];
                } else {
                    command = "node";
                    args = [
                        "index.js",
                    ];
                }
            } catch (err) {
                console.error(`[${this.name}] Failed to parse package.json: ${err.message}`);
            }
        }

        // Pass resolved cwd to executeServiceCommand
        return await this.executeServiceCommand(command, args, {}, {
            cwd,
        });
    }

    async buildApp() {
        const { cwd, pkgPath } = this._resolveNodePaths();
        console.log(`[BUILD] Installing Node dependencies in ${cwd}...`);

        const installSuccess = await this.runBuildCommand(
            "npm",
            [
                "install",
                "--omit=dev",
            ],
            {
                cwd,
                shell: true,
            },
        );

        if (!installSuccess) {
            console.error(`[BUILD] Dependency installation failed for ${this.name}`);
            return false;
        }

        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
                if (pkg.scripts?.build) {
                    console.log(`[BUILD] Running npm run build for ${this.name}...`);
                    await this.runBuildCommand(
                        "npm",
                        [
                            "run",
                            "build",
                        ],
                        {
                            cwd,
                            shell: true,
                        },
                    );
                }
            } catch (e) {
                console.error(`[BUILD] Build step error: ${e.message}`);
            }
        }

        return true;
    }
}

module.exports = NodeApp;
