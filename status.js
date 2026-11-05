/**
 * @file status.js
 * @description Sous-classe StatusApp en charge de l'interrogation système,
 * du calcul de l'empreinte RAM et de l'envoi de la page de statut.
 */

const child_process = require("child_process");
const fs = require("fs");
const path = require("path");

const config = require("./config");
const { App, refreshKnownApps } = require("./app");

class StatusApp extends App {
    constructor() {
        super("status", __dirname);
        this.type = "internal";
    }

    /**
     * Calcule la consommation RAM d'un processus spécifique (RSS).
     */
    getAppRam(pid) {
        try {
            if (!pid) return 0;
            const output = child_process.execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8" });
            const rssKb = parseInt(output.trim(), 10);
            if (isNaN(rssKb)) return 0;
            return Math.round(rssKb / 1024);
        } catch (e) {
            return 0;
        }
    }

    /**
     * Compile et sert les données d'état au format JSON.
     */
    serveStatusData(req, res) {
        refreshKnownApps();
        const proxyRam = this.getAppRam(process.pid);
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

        const payload = JSON.stringify({ proxyRam, totalRam, apps: appsList });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(payload);
    }

    /**
     * Lit et sert le fichier HTML statique externe 'status.html'.
     */
    serveStatusPage(req, res) {
        const htmlPath = path.join(__dirname, "status.html");
        if (fs.existsSync(htmlPath)) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            fs.createReadStream(htmlPath).pipe(res);
        } else {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Page de statut introuvable.");
        }
    }
}

module.exports = new StatusApp();
