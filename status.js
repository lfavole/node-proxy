/**
 * @file status.js
 * @description System metrics and status page handler with fast non-blocking memory telemetry.
 * Reads Linux /proc/<pid>/statm natively without spawning external subprocesses.
 */

const fs = require("fs");
const path = require("path");
const child_process = require("child_process");
const config = require("./config");
const { App, refreshKnownApps } = require("./app");

class StatusApp extends App {
    constructor() {
        super("status", __dirname);
        this.type = "internal";
    }

    /**
     * Reads RSS memory in MB synchronously and fast on Linux via /proc.
     */
    getAppRam(pid) {
        if (!pid) return 0;

        // Native Linux optimization: direct read of /proc/<pid>/statm
        try {
            const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf8");
            const residentPages = parseInt(statm.trim().split(/\s+/)[1], 10);
            if (!isNaN(residentPages)) {
                // Page size = 4096 bytes (4 KB) -> Convert to MB
                return Math.round((residentPages * 4) / 1024);
            }
        } catch (_) {
            // Fallback for macOS or environments without /proc
        }

        // Subprocess fallback
        try {
            if (process.platform === "win32") return 0;
            const output = child_process.execSync(`ps -o rss= -p ${pid}`, {
                encoding: "utf8",
                timeout: 500,
            });
            const rssKb = parseInt(output.trim(), 10);
            return isNaN(rssKb) ? 0 : Math.round(rssKb / 1024);
        } catch {
            return 0;
        }
    }

    serveStatusData(req, res) {
        refreshKnownApps();
        const proxyRam = this.getAppRam(process.pid) || Math.round(process.memoryUsage().rss / (1024 * 1024));
        let totalRam = proxyRam;
        const appsList = [];

        for (const [name, app] of config.apps.entries()) {
            let ramVal = 0;
            if (app.process?.pid) {
                ramVal = this.getAppRam(app.process.pid);
                totalRam += ramVal;
            }
            appsList.push({
                name,
                type: app.type,
                status: app.status,
                port: app.port || "-",
                ram: ramVal > 0 ? ramVal : "-",
            });
        }

        const payload = JSON.stringify({
            proxyRam,
            totalRam,
            uptimeSeconds: Math.round(process.uptime()),
            apps: appsList,
        });

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
        });
        res.end(payload);
    }

    serveStatusPage(req, res) {
        const htmlPath = path.join(__dirname, "status.html");
        if (fs.existsSync(htmlPath)) {
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
            });
            fs.createReadStream(htmlPath).pipe(res);
        } else {
            res.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8",
            });
            res.end("Not Found");
        }
    }
}

module.exports = new StatusApp();
