/**
 * @file app-types/static.js
 * @description High-performance static file server without dependencies.
 * Stream-based with strict Directory Traversal protection and zero URL allocation overhead.
 */

const fs = require("fs");
const path = require("path");
const stream = require("stream");
const App = require("../app-base");

// Pre-allocated MIME table in memory
const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".wasm": "application/wasm",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".csv": "text/csv; charset=utf-8",
    ".zip": "application/zip",
};

class StaticApp extends App {
    constructor(name, fullPath) {
        super(name, fullPath);
        this.type = "static";
    }

    async startApp() {
        this.status = "running";
        this.startPromise = null;
        return this;
    }

    async buildApp() {
        console.log(`[BUILD] Static application ${this.name} requires no build steps.`);
        return true;
    }

    /**
     * Serves static files asynchronously via direct stream pipeline.
     */
    serveStaticApp(req, res) {
        // Lightweight extraction of path without url.parse
        const rawUrl = req.url;
        const queryIdx = rawUrl.indexOf("?");
        const pathOnly = queryIdx == -1 ? rawUrl : rawUrl.slice(0, queryIdx);

        let decodedPath;
        try {
            decodedPath = decodeURIComponent(pathOnly);
        } catch {
            res.writeHead(400, {
                "Content-Type": "text/plain; charset=utf-8",
            });
            res.end("Bad Request");
            return;
        }

        if (decodedPath == "/" || decodedPath == "") {
            decodedPath = "/index.html";
        }

        const safeRoot = path.resolve(this.path);
        // Absolute normalization
        const filePath = path.resolve(safeRoot, "." + path.normalize(decodedPath));

        // Strict Directory Traversal boundary check
        const relative = path.relative(safeRoot, filePath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            res.writeHead(403, {
                "Content-Type": "text/plain; charset=utf-8",
            });
            res.end("Forbidden");
            return;
        }

        // Prevent access to hidden files and directories (.git, .env)
        const baseName = path.basename(filePath);
        if (baseName.startsWith(".") && baseName !== ".well-known") {
            res.writeHead(403, {
                "Content-Type": "text/plain; charset=utf-8",
            });
            res.end("Forbidden");
            return;
        }

        // Non-blocking file metadata inspection
        fs.stat(filePath, (err, stats) => {
            if (err || stats.isDirectory()) {
                res.writeHead(404, {
                    "Content-Type": "text/plain; charset=utf-8",
                });
                res.end("Not Found");
                return;
            }

            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || "application/octet-stream";

            res.writeHead(200, {
                "Content-Type": contentType,
                "Content-Length": stats.size,
                "Cache-Control": "public, max-age=3600",
            });

            // Direct streaming pipeline
            const fileStream = fs.createReadStream(filePath);
            stream.pipeline(fileStream, res, (pipeErr) => {
                if (pipeErr && pipeErr.code !== "ERR_STREAM_PREMATURE_CLOSE") {
                    console.error(`[STATIC STREAM ERR] ${pipeErr.message}`);
                }
            });
        });
    }
}

module.exports = StaticApp;
