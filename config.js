/**
 * @file config.js
 * @description Centralisation des configurations, des constantes globales, des modules
 * système et de la structure de stockage partagée pour le reverse proxy.
 */

const path = require("path");
const http = require("http");

// Constantes de configuration globale
const BASE_DIR = path.join(__dirname, "..");
const PROXY_PORT = process.env.PORT || 3000;
const START_PORT = 3001;
const DOMAIN = "lfavole.fr";
const MAX_RETRIES = 5;
const RETRY_DELAY = 150;
const HEALTH_CHECK_INTERVAL = 300000; // 5 minutes
const GRACE_PERIOD = 15000; // 15 secondes
const IDLE_TIMEOUT = 300000; // 5 minutes

// Liste unique centralisant toutes les instances de la classe App
const apps = new Map();

// Variable globale incrémentielle pour suivre le prochain port à tester
let nextPort = START_PORT;

// Agent HTTP global pour l'optimisation des sockets
const agent = new http.Agent({
    // On ne garde pas de sockets persistantes en mutualisé
    keepAlive: false,
    // Laisse 1 minute de battement réseau maximum
    timeout: 60000,
    // Maintient la socket ouverte 10s en inactivité
    keepAliveMsecs: 10000,
    // Limite le nombre de sockets parallèles par application proxiée
    maxSockets: 100,
    // Nombre maximum de sockets laissées en attente
    maxFreeSockets: 10,
    // Laisse 2 min au proxy pour encaisser le réveil de l'infra
    timeout: 120000,
});

module.exports = {
    BASE_DIR, PROXY_PORT, START_PORT, DOMAIN,
    MAX_RETRIES, RETRY_DELAY, HEALTH_CHECK_INTERVAL, GRACE_PERIOD, IDLE_TIMEOUT,
    apps,
    agent,
    getNextPort: () => nextPort,
    incrementPort: () => { nextPort++; },
};
