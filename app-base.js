/**
 * @file app-base.js
 * @description Abstract base class managing lifecycle, networking, and concurrency.
 * Provides process group isolation, graceful shutdowns, and automatic restart handling.
 * Integrates cold start duration tracking using Exponential Moving Average.
 */

const child_process = require("child_process");
const http = require("http");
const net = require("net");
const readline = require("readline");
const config = require("./config");
const metrics = require("./metrics");

class App {
    static eventListeners = [];

    /**
     * Broadcasts application lifecycle state changes to telemetry listeners.
     */
    static emitAppEvent(appName, event, details = {}) {
        const payload = {
            app: appName,
            event,
            timestamp: Date.now(),
            details,
        };
        for (const listener of App.eventListeners) {
            try {
                listener(payload);
            } catch (_) {}
        }
    }

    /**
     * Registers a listener for application lifecycle events.
     */
    static onAppEvent(listener) {
        App.eventListeners.push(listener);
    }

    constructor(name, fullPath) {
        this.name = name;
        this.path = fullPath;
        // Possible statuses: "stopped", "start", "running"
        this.status = "stopped";
        this.port = null;
        this.process = null;
        this.lastAccessed = null;
        this.startPromise = null;
        this.currentHealthCheckPromise = null;
    }

    /**
     * Checks if the application is responding to HTTP requests on its assigned port.
     */
    async isAppReady() {
        if (!this.port) return false;
        if (this.currentHealthCheckPromise) return this.currentHealthCheckPromise;

        this.currentHealthCheckPromise = (async () => {
            for (let retries = 0; retries < config.MAX_RETRIES; retries++) {
                const result = await new Promise((resolve) => {
                    const req = http.request(
                        {
                            hostname: "127.0.0.1",
                            port: this.port,
                            path: "/",
                            method: "HEAD",
                            timeout: 1500,
                        },
                        (res) => {
                            // Release underlying network buffers immediately
                            res.resume();
                            resolve(true);
                        },
                    );

                    req.on("error", () => resolve(false));
                    req.on("timeout", () => {
                        req.destroy();
                        resolve(false);
                    });
                    req.end();
                });

                if (result) return true;
                if (retries < config.MAX_RETRIES - 1) {
                    await new Promise((r) => setTimeout(r, config.RETRY_DELAY));
                }
            }
            return false;
        })();

        try {
            return await this.currentHealthCheckPromise;
        } finally {
            this.currentHealthCheckPromise = null;
        }
    }

    /**
     * Finds an available TCP port atomically without TOCTOU race conditions.
     */
    async findAvailablePort() {
        const maxAttempts = 60;
        for (let i = 0; i < maxAttempts; i++) {
            const port = config.getAndIncrementPort();
            const isFree = await new Promise((resolve) => {
                const srv = net.createServer();
                srv.once("error", () => resolve(false));
                srv.once("listening", () => {
                    srv.close(() => resolve(true));
                });
                srv.listen(port, "127.0.0.1");
            });
            if (isFree) return port;
        }
        throw new Error(`No available TCP port found after ${maxAttempts} attempts`);
    }

    /**
     * Spawns a child process with process group isolation.
     */
    async executeServiceCommand(command, args, envOptions = {}, spawnOptions = {}) {
        const port = await this.findAvailablePort();
        const env = Object.assign({}, process.env, envOptions, {
            PORT: port.toString(),
        });
        const cwd = spawnOptions.cwd || this.path;
        const isPosix = process.platform !== "win32";

        // detached: true creates a new process group to terminate all descendants at once
        const proc = child_process.spawn(command, args, {
            cwd,
            env,
            detached: isPosix,
            stdio: [
                "ignore",
                "pipe",
                "pipe",
            ],
        });

        let isProcessAlive = true;
        let processExitError = null;

        proc.on("error", (err) => {
            isProcessAlive = false;
            processExitError = err;
            console.error(`[${this.name} CRITICAL] Spawn error: ${err.message}`);
            App.emitAppEvent(this.name, "crash", { error: err.message });
            this.status = "stopped";
            this.port = null;
            this.process = null;
            this.startPromise = null;
        });

        proc.on("exit", (code, signal) => {
            isProcessAlive = false;
            if (code !== 0 && code !== null) {
                processExitError = new Error(`Process terminated unexpectedly with code ${code}`);
            }
            console.log(`[${this.name} LOG] Process stopped (Code: ${code}, Signal: ${signal})`);
            App.emitAppEvent(this.name, (code != 0 && code != null) ? "crash" : "stopped", { code, signal });

            // Reset state immediately to allow automatic restart on the next incoming request
            this.status = "stopped";
            this.port = null;
            this.process = null;
            this.startPromise = null;
        });

        const rlOut = readline.createInterface({ input: proc.stdout });
        rlOut.on("line", (line) => process.stdout.write(`[${this.name}] ${line}\n`));

        const rlErr = readline.createInterface({ input: proc.stderr });
        rlErr.on("line", (line) => process.stderr.write(`[${this.name} ERR] ${line}\n`));

        this.process = proc;
        this.port = port;
        this.status = "start";
        App.emitAppEvent(this.name, "start", { port });

        // Wait for health check confirmation or immediate failure
        const ready = await new Promise(async (resolve) => {
            await new Promise((r) => setTimeout(r, 120));
            if (!isProcessAlive) {
                resolve(false);
                return;
            }
            const isReady = await this.isAppReady();
            resolve(isReady);
        });

        if (!ready || !isProcessAlive) {
            this.startPromise = null;
            if (!isProcessAlive) {
                this.status = "stopped";
                this.port = null;
                this.process = null;
                throw processExitError || new Error(`Application '${this.name}' failed to start.`);
            } else {
                this.startBackgroundCheck();
                throw new Error("Application is still loading");
            }
        }

        this.status = "running";
        App.emitAppEvent(this.name, "running", { port: this.port });
        this.lastAccessed = Date.now();
        this.startPromise = null;
        // Always return the application instance
        return this;
    }

    /**
     * Executes a build or installation utility command.
     */
    async runBuildCommand(command, args, options = {}) {
        return new Promise((resolve) => {
            const proc = child_process.spawn(command, args, options);
            proc.stdout?.on("data", (d) => process.stdout.write(d));
            proc.stderr?.on("data", (d) => process.stderr.write(d));
            proc.on("close", (code) => resolve(code == 0));
        });
    }

    /**
     * Background polling for applications with longer initialization times.
     */
    startBackgroundCheck() {
        let elapsed = 0;
        const interval = setInterval(async () => {
            elapsed += 1000;
            const ready = await this.isAppReady();
            if (ready) {
                clearInterval(interval);
                this.status = "running";
                App.emitAppEvent(this.name, "running", { port: this.port });
                this.lastAccessed = Date.now();
                console.log(`[PROXY] Application ${this.name} started in background on port ${this.port}.`);
                return;
            }
            if (elapsed >= 30000) {
                clearInterval(interval);
                console.log(`[PROXY] Background start timed out for ${this.name} after 30s. Stopping.`);
                this.stopAppCleanly();
            }
        }, 1000);
    }

    async startApp() {
        throw new Error("startApp() must be implemented by subclasses.");
    }

    async buildApp() {
        throw new Error("buildApp() must be implemented by subclasses.");
    }

    /**
     * Retrieves the running application or starts it with safe promise deduplication.
     */
    async getOrStartApp() {
        if (this.status == "running") {
            this.lastAccessed = Date.now();
            return this;
        }

        // Return the existing initialization lock if startup is already underway
        if (this.startPromise) {
            await this.startPromise;
            return this;
        }

        if (this.status == "start") {
            const ready = await this.isAppReady();
            if (ready) {
                this.status = "running";
                this.lastAccessed = Date.now();
                return this;
            }
            throw new Error("Application is still loading");
        }

        const bootStartTime = Date.now();

        // Launch initialization with a shared promise lock
        this.startPromise = this.startApp()
            .then(async () => {
                const elapsed = Date.now() - bootStartTime;
                // Record startup duration asynchronously for the progress bar
                await metrics.recordLoadingDuration(this.name, elapsed);
                return this;
            })
            .catch((err) => {
                this.startPromise = null;
                throw err;
            });

        await this.startPromise;
        return this;
    }

    /**
     * Stops the application with SIGTERM followed by guaranteed SIGKILL fallback.
     */
    stopAppCleanly() {
        const procToKill = this.process;
        const isPosix = process.platform !== "win32";

        if (procToKill) {
            try {
                if (isPosix && procToKill.pid) {
                    process.kill(-procToKill.pid, "SIGTERM");
                } else {
                    procToKill.kill("SIGTERM");
                }
            } catch (err) {
                procToKill.kill("SIGTERM");
            }

            // Guaranteed SIGKILL escalation using local variable reference
            setTimeout(() => {
                if (procToKill.exitCode == null) {
                    try {
                        if (isPosix && procToKill.pid) {
                            process.kill(-procToKill.pid, "SIGKILL");
                        } else {
                            procToKill.kill("SIGKILL");
                        }
                    } catch (e) {
                        try {
                            procToKill.kill("SIGKILL");
                        } catch (_) {}
                    }
                }
            }, config.GRACE_PERIOD);
        }

        this.status = "stopped";
        this.port = null;
        this.process = null;
        this.startPromise = null;
        App.emitAppEvent(this.name, "stopped", {});
    }
}

module.exports = App;
