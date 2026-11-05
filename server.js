/**
 * @file server.js
 * @description High-performance HTTP and WebSocket reverse proxy server.
 * Optimized for minimal RAM footprint, zero external dependencies, and direct streaming.
 */

const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const stream = require("stream");
const config = require("./config");
const { refreshKnownApps } = require("./app");
const statusApp = require("./status");

// In-memory cache of the loading HTML template to avoid repeated disk reads
let cachedLoadingTemplate = null;

function getLoadingTemplate() {
    if (cachedLoadingTemplate) return cachedLoadingTemplate;
    const minPath = path.join(__dirname, "loading.min.html");
    const stdPath = path.join(__dirname, "loading.html");
    const target = [
        minPath,
        stdPath,
    ].find((p) => fs.existsSync(p));

    if (target) {
        cachedLoadingTemplate = fs.readFileSync(target, "utf8");
    }
    return cachedLoadingTemplate;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function handleAppLoadingResponse(res, appName) {
    const template = getLoadingTemplate();
    const safeName = escapeHtml(appName);
    if (template) {
        res.writeHead(503, {
            "Content-Type": "text/html; charset=utf-8",
        });
        res.end(template.replace(/\${appName}/g, safeName));
    } else {
        res.writeHead(503, {
            "Content-Type": "text/plain; charset=utf-8",
            Refresh: "3",
        });
        res.end("Service Unavailable: Application is starting, please wait...");
    }
}

function proxyRequest(app, req, res) {
    const remoteIp = req.socket.remoteAddress || "127.0.0.1";
    req.headers["x-forwarded-for"] = req.headers["x-forwarded-for"]
        ? `${req.headers["x-forwarded-for"]}, ${remoteIp}`
        : remoteIp;
    req.headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
    req.headers["x-forwarded-host"] = req.headers.host || "";

    const options = {
        hostname: "127.0.0.1",
        port: app.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
        agent: config.agent,
    };

    const proxyReq = http.request(options, (proxyRes) => {
        if (!res.headersSent) {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
        }
        stream.pipeline(proxyRes, res, (err) => {
            if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
                console.error(`[PROXY DOWNLOAD PIPE ERR] ${err.message}`);
            }
        });
    });

    proxyReq.setTimeout(120000, () => {
        console.error(`[PROXY TIMEOUT] Application on port ${app.port} is not responding.`);
        proxyReq.destroy();
        if (!res.headersSent) {
            res.writeHead(504, {
                "Content-Type": "text/plain; charset=utf-8",
            });
            res.end("Gateway Timeout");
        }
    });

    proxyReq.on("error", (err) => {
        if (!res.headersSent) {
            res.writeHead(502, {
                "Content-Type": "text/plain; charset=utf-8",
            });
            res.end("Bad Gateway");
        }
        req.destroy();
    });

    stream.pipeline(req, proxyReq, (err) => {
        if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") {
            req.destroy();
        }
    });
}

function proxyWebSocket(app, req, socket, head) {
    const targetSocket = net.connect(app.port, "127.0.0.1", () => {
        let rawHeaders = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            rawHeaders += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
        }
        rawHeaders += "\r\n";

        if (!targetSocket.write(rawHeaders) || (head && head.length > 0 && !targetSocket.write(head))) {
            socket.pause();
        }
        targetSocket.on("drain", () => socket.resume());

        stream.pipeline(socket, targetSocket, () => {});
        stream.pipeline(targetSocket, socket, () => {});
    });

    const intv = setInterval(() => {
        app.lastAccessed = Date.now();
    }, 30000);
    intv.unref();

    const cleanup = () => {
        clearInterval(intv);
    };

    targetSocket.on("end", () => {
        cleanup();
        socket.end();
    });
    targetSocket.on("close", (hadError) => {
        cleanup();
        if (!hadError) socket.end();
        else socket.destroy();
    });
    targetSocket.on("error", (err) => {
        cleanup();
        socket.destroy(err);
    });
    socket.on("error", (err) => {
        cleanup();
        targetSocket.destroy(err);
    });
    socket.on("close", () => {
        cleanup();
        targetSocket.destroy();
    });
}

function extractSubdomain(host) {
    if (!host) return null;
    const cleanHost = host.split(":")[0].toLowerCase();
    const domain = config.DOMAIN.toLowerCase();

    if (cleanHost === domain) return null;
    if (cleanHost.endsWith(`.${domain}`)) {
        return cleanHost.slice(0, -(domain.length + 1));
    }

    // Local development support (e.g., app.localhost)
    if (cleanHost.endsWith(".localhost")) {
        return cleanHost.slice(0, -".localhost".length);
    }

    return null;
}

function startServer() {
    refreshKnownApps(true);

    const server = http.createServer((req, res) => {
        const host = req.headers.host || "";
        const rawUrl = req.url;
        const qIdx = rawUrl.indexOf("?");
        const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);

        // Status and health monitoring routing
        if (host.startsWith("status.") || pathname.startsWith("/_status") || pathname.startsWith("/status")) {
            if (pathname === "/status/data" || pathname === "/_status/data") {
                statusApp.serveStatusData(req, res);
                return;
            }
            statusApp.serveStatusPage(req, res);
            return;
        }

        let subdomain = extractSubdomain(host);

        // Fallback for root domain, direct IP, or localhost access
        if (!subdomain) {
            if (config.DEFAULT_APP && config.apps.has(config.DEFAULT_APP)) {
                subdomain = config.DEFAULT_APP;
            } else if (config.apps.has("www")) {
                subdomain = "www";
            } else {
                // Neutral response for root domain without exposing server internals
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                });
                res.end("<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Proxy Service</title><style>body{font-family:sans-serif;margin:40px;color:#333}</style></head><body><h1>Proxy Service Online</h1><p>Reverse proxy gateway is operational.</p><p><a href=\"/status\">Status Page</a></p></body></html>");
                return;
            }
        }

        // Throttled scan for new applications
        refreshKnownApps();

        const appInstance = config.apps.get(subdomain);
        if (!appInstance) {
            res.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8",
            });
            res.end("Not Found");
            return;
        }

        // Dedicated lightweight health check endpoint
        if (pathname === "/_hc") {
            res.writeHead(appInstance.status === "running" ? 404 : 503);
            res.end("");
            return;
        }

        (async () => {
            const startTime = Date.now();
            const MAX_WAIT_MS = 60000;
            let isClientConnected = true;

            req.on("close", () => {
                isClientConnected = false;
            });

            while (isClientConnected) {
                try {
                    const app = await appInstance.getOrStartApp();
                    if (!app) throw new Error("Application instance undefined");

                    // Static file routing vs reverse proxy routing
                    if (app.type === "static") {
                        app.serveStaticApp(req, res);
                    } else {
                        proxyRequest(app, req, res);
                    }
                    break;
                } catch (err) {
                    if (err.message === "Application is still loading" || appInstance.status === "start") {
                        const isBrowserNav =
                            req.headers["sec-fetch-mode"] === "navigate" &&
                            req.headers["sec-fetch-dest"] === "document";
                        const prefersHtml = req.headers["accept"] && req.headers["accept"].includes("text/html");
                        const isHuman = isBrowserNav || (!req.headers["sec-fetch-mode"] && prefersHtml);

                        if (isHuman) {
                            handleAppLoadingResponse(res, subdomain);
                            return;
                        }

                        if (Date.now() - startTime > MAX_WAIT_MS) {
                            res.writeHead(504, {
                                "Content-Type": "text/plain; charset=utf-8",
                            });
                            res.end("Gateway Timeout");
                            return;
                        }

                        await new Promise((resolve) => setTimeout(resolve, 400));
                    } else {
                        if (!res.headersSent) {
                            res.writeHead(500, {
                                "Content-Type": "text/plain; charset=utf-8",
                            });
                            res.end("Internal Server Error");
                        }
                        return;
                    }
                }
            }
        })();
    });

    server.timeout = 0;
    server.keepAliveTimeout = 60000;
    server.headersTimeout = 30000;

    server.on("upgrade", (req, socket, head) => {
        const host = req.headers.host || "";
        const subdomain = extractSubdomain(host);
        if (!subdomain) return socket.destroy();

        refreshKnownApps();
        const appInstance = config.apps.get(subdomain);
        if (!appInstance) return socket.destroy();

        appInstance
            .getOrStartApp()
            .then((app) => {
                if (app.type === "static") socket.destroy();
                else proxyWebSocket(app, req, socket, head);
            })
            .catch(() => socket.destroy());
    });

    // Periodic idle cleanup
    const idleCheckInterval = setInterval(async () => {
        const now = Date.now();
        const appsArray = Array.from(config.apps.entries());

        await Promise.allSettled(
            appsArray.map(async ([appName, app]) => {
                if (app.status === "running" && app.type !== "static") {
                    const ready = await app.isAppReady();
                    if (!ready) {
                        console.log(`[PROXY] Application ${appName} is unresponsive. Cleaning up.`);
                        app.stopAppCleanly();
                        return;
                    }
                    if (now - app.lastAccessed > config.IDLE_TIMEOUT) {
                        console.log(`[PROXY] Application ${appName} has been idle for over 5 minutes. Stopping.`);
                        app.stopAppCleanly();
                    }
                }
            }),
        );
    }, config.HEALTH_CHECK_INTERVAL);

    idleCheckInterval.unref();

    // Periodic garbage collection suggestion if exposed via node flag
    if (global.gc) {
        const gcInterval = setInterval(() => {
            global.gc();
        }, 5 * 60 * 1000);
        gcInterval.unref();
    }

    server.listen(config.PROXY_PORT, () => {
        console.log(`[PROXY] Reverse Proxy active on port ${config.PROXY_PORT} (Domain: ${config.DOMAIN})`);
    });

    return server;
}

// Global process error safety guards
process.on("uncaughtException", (err) => {
    console.error(`[PROXY CRITICAL ERROR PREVENTED] Uncaught Exception: ${err.message}`, err.stack);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("[PROXY CRITICAL ERROR PREVENTED] Unhandled Rejection at:", promise, "reason:", reason);
});

module.exports = {
    startServer,
};
