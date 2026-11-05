/**
 * @file status.js
 * @description System metrics and status page handler with fast non-blocking memory telemetry.
 * 100% asynchronous: reads Linux /proc/<pid>/statm without blocking disk or event loop.
 */

const fs = require("fs");
const fsp = require("fs").promises;
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
     * Asynchronously reads RSS memory in MB on Linux via /proc without blocking.
     */
    async getAppRam(pid) {
        if (!pid) return 0;

        // Native Linux async optimization: non-blocking read of /proc/<pid>/statm
        try {
            const statm = await fsp.readFile(`/proc/${pid}/statm`, "utf8");
            const residentPages = parseInt(statm.trim().split(/\s+/)[1], 10);
            if (!isNaN(residentPages)) {
                // Page size = 4096 bytes (4 KB) -> Convert to MB
                return Math.round((residentPages * 4) / 1024);
            }
        } catch (_) {
            // Fallback for macOS or environments without /proc
        }

        // Asynchronous non-blocking subprocess fallback
        return new Promise((resolve) => {
            if (process.platform == "win32") return resolve(0);
            child_process.exec(
                `ps -o rss= -p ${pid}`,
                {
                    timeout: 600,
                },
                (err, stdout) => {
                    if (err) return resolve(0);
                    const rssKb = parseInt((stdout || "").trim(), 10);
                    resolve(isNaN(rssKb) ? 0 : Math.round(rssKb / 1024));
                },
            );
        });
    }

    async serveStatusData(req, res) {
        await refreshKnownApps();
        const proxyRam =
            (await this.getAppRam(process.pid)) || Math.round(process.memoryUsage().rss / (1024 * 1024));
        let totalRam = proxyRam;
        const appsList = [];

        const appEntries = Array.from(config.apps.entries());
        for (const [name, app] of appEntries) {
            let ramVal = 0;
            if (app.process?.pid) {
                ramVal = await this.getAppRam(app.process.pid);
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

    async serveStatusPage(req, res) {
        const htmlPath = path.join(__dirname, "status.html");
        try {
            await fsp.access(htmlPath);
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
            });
            fs.createReadStream(htmlPath).pipe(res);
        } catch {
            res.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8",
            });
            res.end("Not Found");
        }
    }
}

module.exports = new StatusApp();
