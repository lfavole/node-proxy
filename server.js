/**
 * @file server.js
 * @description Serveur HTTP principal gérant la couche de routage d'entrée,
 * la distribution vers le stockage statique ou le proxying vers les sockets applicatives.
 */

const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const stream = require("stream");

const config = require("./config");
const { refreshKnownApps } = require("./app");
const statusApp = require("./status");

function proxyRequest(app, req, res) {
    // Injection des en-têtes de traçabilité IP pour les sous-applications
    const remoteIp = req.socket.remoteAddress;
    req.headers['x-forwarded-for'] = req.headers['x-forwarded-for'] 
        ? `${req.headers['x-forwarded-for']}, ${remoteIp}` 
        : remoteIp;
    req.headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
    req.headers['x-forwarded-host'] = req.headers.host || '';

    const options = {
        hostname: "127.0.0.1",
        port: app.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
        agent: config.agent,
    };

    const proxyReq = http.request(options, (proxyRes) => {
        if (!res.headersSent)
            res.writeHead(proxyRes.statusCode, proxyRes.headers);

        stream.pipeline(proxyRes, res, (err) => {
            if (err) console.error(`[PROXY DOWNLOAD PIPE ERR] ${err.message}`);
        });
    });

    // On ne coupe la socket du proxy que si l'application proxiée
    // ne donne absolument aucun signe de vie pendant 2 minutes (socket figée).
    proxyReq.setTimeout(120000, () => {
        console.error(`[PROXY TIMEOUT] L'application sur le port ${app.port} ne répond plus.`);
        proxyReq.destroy();
        if (!res.headersSent) {
            res.writeHead(504, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Gateway Timeout");
        }
    });

    proxyReq.on("error", (err) => {
        if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Bad Gateway");
        }
        req.destroy();
        console.error(`[PROXY REQ ERR] ${err.message}`);
    });

    stream.pipeline(req, proxyReq, (err) => {
        if (err) {
            console.error(`[PROXY REQ PIPE ERR] ${err.message}`);
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

        // CORRECTIF BACKPRESSURE (Écriture initiale sécurisée)
        if (!targetSocket.write(rawHeaders) || (head?.length > 0 && !targetSocket.write(head))) {
            socket.pause(); // On met le client en pause si le tampon de l'application cible s'engorge
        }
        targetSocket.on('drain', () => socket.resume());

        stream.pipeline(socket, targetSocket, (err) => {
            if (err) console.error(`[WS PIPE ERR] ${err.message}`);
        });
        stream.pipeline(targetSocket, socket, (err) => {
            if (err) console.error(`[WS TARGET PIPE ERR] ${err.message}`);
        });
    });

    // On garde l'application active si le socket reste connecté
    let intv = setInterval(() => app.lastAccessed = Date.now(), 30000);

    // Événements de fermeture / fin
    targetSocket.on("end", () => {
        console.log("[WS] targetSocket ended");
        clearInterval(intv);
        // fermer la socket client si besoin
        socket.end();
    });

    targetSocket.on("close", (hadError) => {
        console.log("[WS] targetSocket closed", { hadError });
        clearInterval(intv);
        // Si fermé sans erreur, détruire proprement côté client
        if (!hadError)
            socket.end();
        else
            socket.destroy();
    });

    // Propager erreurs
    targetSocket.on("error", (err) => {
        console.error("[WS TARGET ERR]", err.message);
        clearInterval(intv);
        socket.destroy(err);
    });

    socket.on("error", (err) => {
        console.error("[WS CLIENT ERR]", err.message);
        clearInterval(intv);
        targetSocket.destroy(err);
    });

    socket.on("close", (hadError) => {
        console.log("[WS] client socket closed", { hadError });
        clearInterval(intv);
        targetSocket.destroy();
    });
}

function extractSubdomain(host) {
    const cleanHost = host.split(":")[0];
    if (cleanHost == config.DOMAIN) return null;
    if (cleanHost.endsWith(`.${config.DOMAIN}`)) return cleanHost.slice(0, -(config.DOMAIN.length + 1));
    return null;
}

/**
 * Renvoie un mini-script de rechargement en boucle avec un code d'erreur 503 Service Unavailable.
 */
function handleAppLoadingResponse(res, appName) {
    const htmlPath = path.join(__dirname, "loading.html");
    const minHtmlPath = path.join(__dirname, "loading.min.html");
    const path = [minHtmlPath, htmlPath].find(fs.existsSync);

    if (path) {
        res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(path, "utf8").replace("${appName}", appName.replace("<", "&lt;")));

    } else {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Refresh": "5" });
        res.end(`Application '${appName}' toujours en cours de chargement`);
    }
}

function startServer() {
    const server = http.createServer((req, res) => {
        const host = req.headers.host || "";
        // Extraction ultra-légère du pathname sans url.parse
        const pathname = req.url.split('?')[0];

        if (host.startsWith("status.")) {
            if (pathname == "/status/data") {
                statusApp.serveStatusData(req, res);
                return;
            }
            statusApp.serveStatusPage(req, res);
            return;
        }

        const subdomain = extractSubdomain(host);
        if (!subdomain) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Sous-domaine non spécifié");
            return;
        }

        refreshKnownApps();
        const appInstance = config.apps.get(subdomain);

        if (!appInstance) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Application non trouvée");
            return;
        }

        if (pathname == "/_hc") {
            // On utilise le code 404 en cas de succès, car la page de maintenance d'Infomaniak
            // utilise le code 200
            res.writeHead(appInstance.status == "running" ? 404 : 503);
            res.end("");
            return;
        }

        (async () => {
            const startTime = Date.now();
            const MAX_WAIT_MS = 60000;
            let isClientConnected = true;
            req.on("close", () => { isClientConnected = false; });
            while (isClientConnected) {
                try {
                    const app = await appInstance.getOrStartApp();
                    if (app.type == "static")
                        serveStaticApp(app, req, res);
                    else
                        proxyRequest(app, req, res);
                    break;
                } catch (err) {
                    if (err.message == "Application toujours en cours de chargement" || appInstance.status == "start") {
                        const isBrowserNavigation = (
                            req.headers['sec-fetch-mode'] == 'navigate' 
                            && req.headers['sec-fetch-dest'] == 'document'
                        );
    
                        const prefersHtml = (
                            req.headers['accept']
                            && req.headers['accept'].includes('text/html')
                        );
                        const isHumanBrowser = isBrowserNavigation || (!req.headers['sec-fetch-mode'] && prefersHtml);
    
                        if (isHumanBrowser) {
                            handleAppLoadingResponse(res, subdomain);
                            return;
                        }

                        // Gestion du timeout pour les non-navigateurs (Long Polling)
                        if (Date.now() - startTime > MAX_WAIT_MS) {
                            res.writeHead(504, { "Content-Type": "text/plain; charset=utf-8" });
                            res.end(`L'application '${subdomain}' a mis trop de temps à démarrer.`);
                            return;
                        }

                        await new Promise(resolve => setTimeout(resolve, 500));
                    } else {
                        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
                        res.end(err.message || "Erreur interne du proxy");
                        return;
                    }
                }
            }
        })();
    });

    // Configuration des timeouts de la socket réseau
    // Désactive le timeout d'inactivité global (laisser le flux gérer)
    server.timeout = 0;
    // Maintient la connexion persistante ouverte pendant 60s entre deux requêtes
    server.keepAliveTimeout = 60000;
    // Laisse 30s au client pour envoyer ses en-têtes HTTP au démarrage
    server.headersTimeout = 30000;

    server.on("upgrade", (req, socket, head) => {
        const host = req.headers.host || "";
        const subdomain = extractSubdomain(host);
        if (!subdomain) return socket.destroy();

        refreshKnownApps();
        const appInstance = config.apps.get(subdomain);
        if (!appInstance) return socket.destroy();

        appInstance.getOrStartApp()
            .then((app) => {
                if (app.type == "static") socket.destroy();
                else proxyWebSocket(app, req, socket, head);
            })
            .catch(() => socket.destroy());
    });

    // Health check récurrent parallélisé
    setInterval(async () => {
        const now = Date.now();
        const appsArray = Array.from(config.apps.entries());

        // Exécution en parallèle des tests
        await Promise.allSettled(appsArray.map(async ([appName, app]) => {
            if (app.status == "running" && app.type != "static") {
                const ready = await app.isAppReady();
                if (!ready) {
                    console.log(`[PROXY] App ${appName} stopped responding. Cleaning up.`);
                    app.stopAppCleanly();
                    return;
                }
                if (now - app.lastAccessed > config.IDLE_TIMEOUT) {
                    console.log(`[PROXY] App ${appName} has been idle for over 5 minutes. Shutting down.`);
                    app.stopAppCleanly();
                }
            }
        }));
    }, config.HEALTH_CHECK_INTERVAL);

    server.listen(config.PROXY_PORT, () => console.log(`[PROXY] Reverse Proxy listening on port ${config.PROXY_PORT}`));
}

// Capture des erreurs fatales globales pour maintenir le proxy en vie
process.on("uncaughtException", (err) => {
    console.error(`[PROXY CRITICAL CRASH PREVENTED] Uncaught Exception: ${err.message}`, err.stack);
});

process.on("unhandledRejection", (reason, promise) => {
    console.error("[PROXY CRITICAL CRASH PREVENTED] Unhandled Rejection at:", promise, "reason:", reason);
});

// Toutes les 5 minutes, on suggère une libération de la mémoire non utilisée au système
setInterval(() => {
    if (global.gc) {
        global.gc();
    }
}, 5 * 60 * 1000);

module.exports = { startServer };
