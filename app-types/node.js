/**
 * @file app-types/node.js
 * @description Node.js sub-application lifecycle manager supporting root and /server structures.
 * Fully asynchronous to eliminate synchronous disk I/O bottlenecks.
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

class NodeApp extends App {
    constructor(name, fullPath) {
        super(name, fullPath);
        this.type = "node";
    }

    async _resolveNodePaths() {
        let cwd = this.path;
        let pkgPath = path.join(this.path, "package.json");

        if (!(await fileExists(pkgPath))) {
            const nestedPkg = path.join(this.path, "server", "package.json");
            if (await fileExists(nestedPkg)) {
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
        const { cwd, pkgPath } = await this._resolveNodePaths();
        let command = "npm";
        let args = [
            "run",
            "start",
        ];

        if (await fileExists(pkgPath)) {
            try {
                const rawPkg = await fs.readFile(pkgPath, "utf8");
                const pkg = JSON.parse(rawPkg);
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
        const { cwd, pkgPath } = await this._resolveNodePaths();
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

        if (await fileExists(pkgPath)) {
            try {
                const rawPkg = await fs.readFile(pkgPath, "utf8");
                const pkg = JSON.parse(rawPkg);
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
