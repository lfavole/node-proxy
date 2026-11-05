/**
 * @file config.js
 * @description Centralized configuration, global constants, and networking setup.
 * Optimized for minimal RAM footprint and zero external dependencies.
 */

const path = require("path");
const http = require("http");

// Base directory where applications are stored
const BASE_DIR = process.env.APPS_DIR || path.join(__dirname, "..");
const PROXY_PORT = parseInt(process.env.PORT, 10) || 3000;
const START_PORT = parseInt(process.env.START_PORT, 10) || 3001;
const DOMAIN = process.env.DOMAIN || "lfavole.fr";
// Optional default application served for root domain or direct IP access
const DEFAULT_APP = process.env.DEFAULT_APP || null;

const MAX_RETRIES = 5;
const RETRY_DELAY = 150;
// 5 minutes health check interval
const HEALTH_CHECK_INTERVAL = 300000;
// 15 seconds grace period before force kill
const GRACE_PERIOD = 15000;
// 5 minutes idle timeout before stopping inactive applications
const IDLE_TIMEOUT = 300000;

// Central registry of discovered applications
const apps = new Map();

// Circular port counter between START_PORT and 45000
let nextPort = START_PORT;

function getAndIncrementPort() {
    const current = nextPort;
    nextPort = nextPort >= 45000 ? START_PORT : nextPort + 1;
    return current;
}

// Lightweight HTTP agent reusing local sockets without excessive memory overhead
const agent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    // Low socket limit per application to preserve RAM
    maxSockets: 64,
    // Limit idle sockets held in memory
    maxFreeSockets: 8,
    timeout: 60000,
});

module.exports = {
    BASE_DIR,
    PROXY_PORT,
    START_PORT,
    DOMAIN,
    DEFAULT_APP,
    MAX_RETRIES,
    RETRY_DELAY,
    HEALTH_CHECK_INTERVAL,
    GRACE_PERIOD,
    IDLE_TIMEOUT,
    apps,
    agent,
    getNextPort: getAndIncrementPort,
    getAndIncrementPort,
};
