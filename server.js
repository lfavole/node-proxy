/**
 * @file server.js
 * @description High-performance HTTP and WebSocket reverse proxy server.
 * 100% asynchronous: eliminates all synchronous disk calls to prevent I/O blocking.
 * Features multi-language loading pages and EMA progress bar estimations.
 */

const fs = require("fs").promises;
const http = require("http");
const net = require("net");
const path = require("path");
const stream = require("stream");
const config = require("./config");
const { refreshKnownApps } = require("./app");
const statusApp = require("./status");
const metrics = require("./metrics");

// In-memory cache of the loading HTML template to avoid repeated disk reads
let cachedLoadingTemplate = null;

// Multi-language localization dictionary for loading screens
const I18N = {
    en: {
        title: "Application Loading",
        heading: "Application is starting",
        message: "Please wait, this page will reload automatically once ready.",
        estLabel: "Estimated start time:",
        secLabel: "sec",
    },
    fr: {
        title: "Chargement de l'application",
        heading: "L'application démarre",
        message: "Veuillez patienter, cette page se rechargera automatiquement dès qu'elle sera prête.",
        estLabel: "Temps estimé :",
        secLabel: "s",
    },
    es: {
        title: "Cargando aplicación",
        heading: "La aplicación se está iniciando",
        message: "Por favor espere, esta página se recargará automáticamente cuando esté lista.",
        estLabel: "Tiempo estimado:",
        secLabel: "s",
    },
    de: {
        title: "Anwendung lädt",
        heading: "Die Anwendung wird gestartet",
        message: "Bitte warten Sie, diese Seite wird automatisch neu geladen, sobald sie bereit ist.",
        estLabel: "Geschätzte Startzeit:",
        secLabel: "Sek.",
    },
    it: {
        title: "Caricamento applicazione",
        heading: "L'applicazione si sta avviando",
        message: "Attendere prego, la pagina si ricaricherà automaticamente quando pronta.",
        estLabel: "Tempo stimato:",
        secLabel: "s",
    },
    pt: {
        title: "Carregando aplicativo",
        heading: "O aplicativo está iniciando",
        message: "Por favor aguarde, esta página será recarregada automaticamente quando pronta.",
        estLabel: "Tempo estimado:",
        secLabel: "s",
    },
};

/**
 * Detects the user's preferred language from the HTTP Accept-Language header.
 */
function detectLanguage(header) {
    if (!header) return "en";
    const clean = header.toLowerCase();
    const supported = [
        "fr",
        "es",
        "de",
        "it",
        "pt",
    ];

    for (const code of supported) {
        if (clean.startsWith(code) || clean.includes(code + ",") || clean.includes(code + ";")) {
            return code;
        }
    }
    return "en";
}

/**
 * Asynchronously loads and caches the template without blocking the event loop.
 */
async function getLoadingTemplate() {
    if (cachedLoadingTemplate) return cachedLoadingTemplate;

    const minPath = path.join(__dirname, "loading.min.html");
    const stdPath = path.join(__dirname, "loading.html");

    try {
        cachedLoadingTemplate = await fs.readFile(minPath, "utf8");
        return cachedLoadingTemplate;
    } catch {
        try {
            cachedLoadingTemplate = await fs.readFile(stdPath, "utf8");
            return cachedLoadingTemplate;
        } catch {
            return null;
        }
    }
}

/**
 * Serves the localized loading screen with an animated progress bar based on EMA.
 */
async function handleAppLoadingResponse(req, res, appName) {
    const template = await getLoadingTemplate();
    const langCode = detectLanguage(req.headers["accept-language"]);
    const text = I18N[langCode] || I18N.en;

    // Fetch the Exponential Moving Average loading estimation for this app
    const estMs = await metrics.getEstimatedLoadingTime(appName);
    const estSec = Math.max(1, Math.round(estMs / 1000));

    if (template) {
        const rendered = template
            .replace(/\${lang}/g, langCode)
            .replace(/\${title}/g, text.title)
            .replace(/\${heading}/g, text.heading)
            .replace(/\${message}/g, text.message)
            .replace(/\${estSec}/g, estSec.toString());

        res.writeHead(503, {
            "Content-Type": "text/html; charset=utf-8",
        });
        res.end(rendered);
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
            if (err && err.code != "ERR_STREAM_PREMATURE_CLOSE") {
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
        if (err && err.code != "ERR_STREAM_PREMATURE_CLOSE") {
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

    if (cleanHost == domain) return null;
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
    // Initial asynchronous scan of applications
    refreshKnownApps(true).catch(() => {});

    const server = http.createServer(async (req, res) => {
        const host = req.headers.host || "";
        const rawUrl = req.url;
        const qIdx = rawUrl.indexOf("?");
        const pathname = qIdx == -1 ? rawUrl : rawUrl.slice(0, qIdx);

        // Status and health monitoring routing
        if (host.startsWith("status.") || pathname.startsWith("/_status") || pathname.startsWith("/status")) {
            if (pathname == "/status/data" || pathname == "/_status/data") {
                await statusApp.serveStatusData(req, res);
                return;
            }
            await statusApp.serveStatusPage(req, res);
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

        // Asynchronous non-blocking application refresh (throttled)
        await refreshKnownApps();

        const appInstance = config.apps.get(subdomain);
        if (!appInstance) {
            res.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8",
            });
            res.end("Not Found");
            return;
        }

        // Dedicated lightweight health check endpoint
        if (pathname == "/_hc") {
            res.writeHead(appInstance.status == "running" ? 404 : 503);
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
                    if (app.type == "static") {
                        app.serveStaticApp(req, res);
                    } else {
                        proxyRequest(app, req, res);
                    }
                    break;
                } catch (err) {
                    if (err.message == "Application is still loading" || appInstance.status == "start") {
                        const isBrowserNav =
                            req.headers["sec-fetch-mode"] == "navigate" &&
                            req.headers["sec-fetch-dest"] == "document";
                        const prefersHtml = req.headers["accept"] && req.headers["accept"].includes("text/html");
                        const isHuman = isBrowserNav || (!req.headers["sec-fetch-mode"] && prefersHtml);

                        if (isHuman) {
                            await handleAppLoadingResponse(req, res, subdomain);
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

    server.on("upgrade", async (req, socket, head) => {
        const host = req.headers.host || "";
        const subdomain = extractSubdomain(host);
        if (!subdomain) return socket.destroy();

        await refreshKnownApps();
        const appInstance = config.apps.get(subdomain);
        if (!appInstance) return socket.destroy();

        appInstance
            .getOrStartApp()
            .then((app) => {
                if (app.type == "static") socket.destroy();
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
                if (app.status == "running" && app.type != "static") {
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
