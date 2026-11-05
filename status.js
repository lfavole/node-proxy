/**
 * @file status.js
 * @description Advanced system metrics, interactive telemetry, and status page handler.
 * Features password authentication, historical RAM sampling, app lifecycle tracking,
 * and proxy restart history with zero external dependencies.
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const child_process = require("child_process");
const crypto = require("crypto");
const config = require("./config");
const { App, refreshKnownApps } = require("./app");

// Path to persistent status telemetry history file
const HISTORY_FILE = path.join(__dirname, "status-history.json");

// Maximum historical records to retain in memory and storage
const MAX_RAM_POINTS = 360;
const MAX_APP_EVENTS = 120;
const MAX_RESTARTS = 30;

class StatusApp extends App {
    constructor() {
        super("status", __dirname);
        this.type = "internal";
        this.restarts = [];
        this.appEvents = [];
        this.ramHistory = [];
        this.historySaveTimer = null;
        this.samplerTimer = null;
        this.sessionSecret = crypto.randomBytes(16).toString("hex");

        this.initHistory();
        this.startLifecycleListener();
        this.startPeriodicSampler();
    }

    /**
     * Computes the authentication token for cookie verification.
     */
    getAuthToken() {
        if (!config.STATUS_PASSWORD) return "";
        return crypto
            .createHmac("sha256", this.sessionSecret)
            .update(config.STATUS_PASSWORD)
            .digest("hex");
    }

    /**
     * Checks if the incoming request has valid authentication credentials.
     */
    checkAuth(req) {
        // If no password is configured, access is open
        if (!config.STATUS_PASSWORD) {
            return true;
        }

        const expectedToken = this.getAuthToken();

        // 1. Check session cookie
        const cookieHeader = req.headers.cookie || "";
        const cookies = cookieHeader.split(";").reduce((acc, str) => {
            const [k, v] = str.trim().split("=");
            if (k && v) acc[k] = v;
            return acc;
        }, {});

        if (cookies["proxy_status_auth"] && cookies["proxy_status_auth"] == expectedToken) {
            return true;
        }

        // 2. Check HTTP Basic Authentication header
        const authHeader = req.headers["authorization"] || "";
        if (authHeader.startsWith("Basic ")) {
            try {
                const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
                const parts = decoded.split(":");
                const pass = parts.length > 1 ? parts.slice(1).join(":") : parts[0];
                if (pass == config.STATUS_PASSWORD) {
                    return true;
                }
            } catch (_) {}
        }

        // 3. Check query parameter token
        const rawUrl = req.url || "";
        const qIdx = rawUrl.indexOf("?");
        if (qIdx != -1) {
            const search = rawUrl.slice(qIdx + 1);
            const params = new URLSearchParams(search);
            if (params.get("auth") == config.STATUS_PASSWORD || params.get("auth") == expectedToken) {
                return true;
            }
        }

        return false;
    }

    /**
     * Initializes and loads telemetry history from disk.
     */
    async initHistory() {
        try {
            const raw = await fsp.readFile(HISTORY_FILE, "utf8");
            const parsed = JSON.parse(raw);
            this.restarts = Array.isArray(parsed.restarts) ? parsed.restarts : [];
            this.appEvents = Array.isArray(parsed.appEvents) ? parsed.appEvents : [];
            this.ramHistory = Array.isArray(parsed.ramHistory) ? parsed.ramHistory : [];
        } catch (_) {
            this.restarts = [];
            this.appEvents = [];
            this.ramHistory = [];
        }

        // Record the current proxy start event
        this.restarts.push({
            timestamp: Date.now(),
            reason: "startup",
        });

        if (this.restarts.length > MAX_RESTARTS) {
            this.restarts = this.restarts.slice(-MAX_RESTARTS);
        }

        await this.saveHistory();
    }

    /**
     * Asynchronously saves historical metrics to disk.
     */
    async saveHistory() {
        try {
            const payload = JSON.stringify(
                {
                    restarts: this.restarts,
                    appEvents: this.appEvents,
                    ramHistory: this.ramHistory,
                },
                null,
                4,
            );
            await fsp.writeFile(HISTORY_FILE, payload, "utf8");
        } catch (_) {}
    }

    /**
     * Listens to application lifecycle events emitted by App instances.
     */
    startLifecycleListener() {
        App.onAppEvent((eventData) => {
            this.appEvents.push({
                app: eventData.app,
                event: eventData.event,
                timestamp: eventData.timestamp || Date.now(),
                details: eventData.details || {},
            });

            if (this.appEvents.length > MAX_APP_EVENTS) {
                this.appEvents = this.appEvents.slice(-MAX_APP_EVENTS);
            }

            // Schedule asynchronous disk persistence
            this.triggerThrottledSave();
        });
    }

    /**
     * Throttles disk writes to at most once every 15 seconds.
     */
    triggerThrottledSave() {
        if (this.historySaveTimer) return;
        this.historySaveTimer = setTimeout(async () => {
            this.historySaveTimer = null;
            await this.saveHistory();
        }, 15000);
        this.historySaveTimer.unref();
    }

    /**
     * Periodic background sampler collecting RAM telemetry every 5 seconds.
     */
    startPeriodicSampler() {
        this.samplerTimer = setInterval(async () => {
            try {
                const proxyRam =
                    (await this.getAppRam(process.pid)) ||
                    Math.round(process.memoryUsage().rss / (1024 * 1024));
                let totalRam = proxyRam;
                const appsRam = {};

                const appEntries = Array.from(config.apps.entries());
                for (const [name, app] of appEntries) {
                    if (app.process?.pid && app.status == "running") {
                        const ramVal = await this.getAppRam(app.process.pid);
                        if (ramVal > 0) {
                            appsRam[name] = ramVal;
                            totalRam += ramVal;
                        }
                    }
                }

                this.ramHistory.push({
                    t: Date.now(),
                    proxy: proxyRam,
                    total: totalRam,
                    apps: appsRam,
                });

                if (this.ramHistory.length > MAX_RAM_POINTS) {
                    this.ramHistory = this.ramHistory.slice(-MAX_RAM_POINTS);
                }
            } catch (_) {}
        }, 5000);

        this.samplerTimer.unref();
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
        } catch (_) {}

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

    /**
     * Serves live telemetry data including RAM history, launch events, and restarts.
     */
    async serveStatusData(req, res) {
        if (!this.checkAuth(req)) {
            res.writeHead(401, {
                "Content-Type": "application/json; charset=utf-8",
                "WWW-Authenticate": "Basic realm=\"Proxy Status\"",
            });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
        }

        await refreshKnownApps();
        const proxyRam =
            (await this.getAppRam(process.pid)) ||
            Math.round(process.memoryUsage().rss / (1024 * 1024));
        let totalRam = proxyRam;
        const appsList = [];

        const appEntries = Array.from(config.apps.entries());
        for (const [name, app] of appEntries) {
            let ramVal = 0;
            if (app.process?.pid && app.status == "running") {
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
            ramHistory: this.ramHistory,
            appEvents: this.appEvents,
            restarts: this.restarts,
        });

        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
        });
        res.end(payload);
    }

    /**
     * Serves the password login form if unauthenticated.
     */
    serveLoginPage(req, res, errorMsg = "") {
        const errorHtml = errorMsg
            ? `<div class="error-msg">${errorMsg}</div>`
            : "";
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Proxy Status Authentication</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #111827;
            color: #f3f4f6;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
        }
        .login-card {
            background: #1f2937;
            padding: 32px;
            border-radius: 12px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.4);
            width: 100%;
            max-width: 360px;
            border: 1px solid #374151;
        }
        h2 {
            margin: 0 0 8px;
            font-size: 20px;
            font-weight: 600;
        }
        p {
            color: #9ca3af;
            font-size: 14px;
            margin: 0 0 20px;
        }
        .error-msg {
            background: #7f1d1d;
            color: #fecaca;
            padding: 10px 14px;
            border-radius: 6px;
            font-size: 13px;
            margin-bottom: 16px;
            border: 1px solid #991b1b;
        }
        label {
            display: block;
            font-size: 13px;
            color: #d1d5db;
            margin-bottom: 6px;
        }
        input[type="password"] {
            width: 100%;
            box-sizing: border-box;
            padding: 10px 12px;
            background: #111827;
            border: 1px solid #4b5563;
            border-radius: 6px;
            color: #fff;
            font-size: 14px;
            margin-bottom: 20px;
        }
        input[type="password"]:focus {
            outline: none;
            border-color: #3b82f6;
        }
        button {
            width: 100%;
            padding: 10px;
            background: #2563eb;
            color: #fff;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.15s;
        }
        button:hover {
            background: #1d4ed8;
        }
    </style>
</head>
<body>
    <div class="login-card">
        <h2>Proxy Status</h2>
        <p>Please enter your access password</p>
        ${errorHtml}
        <form method="POST" action="/status/login">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required autofocus autocomplete="current-password">
            <button type="submit">Unlock Dashboard</button>
        </form>
    </div>
</body>
</html>`;

        res.writeHead(401, {
            "Content-Type": "text/html; charset=utf-8",
            "WWW-Authenticate": "Basic realm=\"Proxy Status\"",
        });
        res.end(html);
    }

    /**
     * Handles POST login submission to verify password and issue authentication cookie.
     */
    async handleLogin(req, res) {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk.toString();
            if (body.length > 4096) req.destroy();
        });

        req.on("end", () => {
            const params = new URLSearchParams(body);
            const pass = params.get("password") || "";

            if (pass == config.STATUS_PASSWORD) {
                const token = this.getAuthToken();
                res.writeHead(302, {
                    Location: "/status",
                    "Set-Cookie": `proxy_status_auth=${token}; Path=/; HttpOnly; SameSite=Lax`,
                });
                res.end("");
            } else {
                this.serveLoginPage(req, res, "Invalid password. Access denied.");
            }
        });
    }

    /**
     * Handles logout request by invalidating the authentication cookie.
     */
    handleLogout(req, res) {
        res.writeHead(302, {
            Location: "/status",
            "Set-Cookie": "proxy_status_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly",
        });
        res.end("");
    }

    /**
     * Serves static assets (CSS, JS) for the status dashboard.
     */
    async serveStaticAsset(req, res, filename, contentType) {
        const filePath = path.join(__dirname, "public", filename);
        try {
            await fsp.access(filePath);
            res.writeHead(200, {
                "Content-Type": `${contentType}; charset=utf-8`,
                "Cache-Control": "public, max-age=3600",
            });
            fs.createReadStream(filePath).pipe(res);
        } catch (_) {
            res.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8",
            });
            res.end("Not Found");
        }
    }

    /**
     * Serves the main status HTML page.
     */
    async serveStatusPage(req, res) {
        if (!this.checkAuth(req)) {
            this.serveLoginPage(req, res);
            return;
        }

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

    /**
     * Main HTTP request router for status endpoints.
     */
    async handleRequest(req, res) {
        const rawUrl = req.url || "";
        const qIdx = rawUrl.indexOf("?");
        const pathname = qIdx == -1 ? rawUrl : rawUrl.slice(0, qIdx);

        if (pathname == "/status/login" && req.method == "POST") {
            await this.handleLogin(req, res);
            return;
        }

        if (pathname == "/status/logout") {
            this.handleLogout(req, res);
            return;
        }

        if (pathname == "/status/status.css" || pathname == "/_status/status.css") {
            await this.serveStaticAsset(req, res, "status.css", "text/css");
            return;
        }

        if (pathname == "/status/status.js" || pathname == "/_status/status.js") {
            await this.serveStaticAsset(req, res, "status.js", "application/javascript");
            return;
        }

        if (pathname == "/status/data" || pathname == "/_status/data") {
            await this.serveStatusData(req, res);
            return;
        }

        await this.serveStatusPage(req, res);
    }
}

module.exports = new StatusApp();
