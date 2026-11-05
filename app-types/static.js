/**
 * @file app-types/static.js
 * @description Sert les fichiers statiques locaux directement via Node.js sans processus tiers.
 */

const fs = require("fs");
const path = require("path");
const stream = require("stream");

const App = require("../app-base");

// Table de correspondance MIME étendue figée en mémoire pour éviter sa ré-allocation à chaque appel
const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8"
};

class StaticApp extends App {
    constructor(name, fullPath) {
        super(name, fullPath);
        // Typage applicatif explicite
        this.type = "static";
    }

    /**
     * Les applications statiques n'ont pas besoin de processus d'arrière-plan autonome.
     */
    async startApp() {
        // Passage immédiat en exécution active
        this.status = "running";
        this.startPromise = null;
        return this;
    }

    /**
     * Pas d'étape de compilation pour le contenu purement statique.
     */
    async buildApp() {
        console.log(`[BUILD] App ${this.name} of type static requires no compile steps.`);
        return true;
    }

    /**
     * Analyse la requête et écrit le fichier en flux (Stream) vers le client HTTP.
     * Version optimisée : Zéro allocation URL, I/O asynchrones non-bloquantes, sécurité Directory Traversal.
     */
    serveStaticApp(req, res) {
        // Extraction du pathname purement textuelle sans charger le module 'url'
        let reqPath = req.url.split('?')[0];
        
        // Redirection par défaut vers le point d'entrée
        if (reqPath === "/") reqPath = "/index.html";
        
        const filePath = path.join(this.path, reqPath);

        // Protection contre les attaques de type Directory Traversal
        if (!filePath.startsWith(this.path)) {
            res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Accès interdit");
            return;
        }

        // Utilisation de fs.stat (asynchrone)
        fs.stat(filePath, (err, stats) => {
            // Si le fichier n'existe pas ou que c'est un dossier, on renvoie un 404 propre
            if (err || stats.isDirectory()) {
                res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("Fichier non trouvé");
                return;
            }

            const ext = path.extname(filePath).toLowerCase();
            const mime = MIME_TYPES[ext] || "application/octet-stream";

            res.writeHead(200, {
                "Content-Type": mime,
                // Indique la taille exacte au navigateur
                "Content-Length": stats.size,
                "Cache-Control": "public, max-age=3600",
            });

            // Lecture asynchrone par morceaux (Stream)
            const fileStream = fs.createReadStream(filePath);
            stream.pipeline(fileStream, res, (pipelineErr) => {
                if (pipelineErr) console.error(`[STATIC PIPE ERR] ${pipelineErr.message}`);
            });
        });
    }
}

module.exports = StaticApp;
