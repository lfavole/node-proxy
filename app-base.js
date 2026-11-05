/**
 * @file app-base.js
 * @description Classe de base abstraite encapsulant la logique métier, le réseau et le cycle de vie.
 */

const child_process = require("child_process");
const http = require("http");
const net = require("net");
const readline = require("readline");

const config = require("./config");

class App {
    constructor(name, fullPath) {
        // Nom de l'application (basé sur le nom du dossier)
        this.name = name;
        // Chemin absolu vers l'application
        this.path = fullPath;
        // États possibles : "stopped", "start", "running"
        this.status = "stopped";
        // Port réseau attribué dynamiquement
        this.port = null;
        // Référence vers le processus enfant créé
        this.process = null;
        // Timestamp du dernier accès HTTP
        this.lastAccessed = null;
        // Verrou asynchrone pour éviter les démarrages simultanés
        this.startPromise = null;
        // Verrou asynchrone pour éviter les tests simultanés
        this.currentHealthCheckPromise = null;
    }

    /**
     * Valide si une application web écoute activement et répond correctement aux requêtes HTTP.
     * Utilise un verrou (cache de promesse) pour éviter le chevauchement des requêtes TCP.
     */
    async isAppReady() {
        // Pas de port assigné, l'application ne peut pas être prête
        if (!this.port) return false;

        // Si un test est déjà en cours, on s'abonne à sa promesse
        if (this.currentHealthCheckPromise) return this.currentHealthCheckPromise;

        // Implémentation du Health Check unique
        this.currentHealthCheckPromise = (async () => {
            for (let retries = 0; retries < config.MAX_RETRIES; retries++) {
                const result = await new Promise((resolve) => {
                    // On utilise la méthode HEAD pour ne pas avoir trop de données
                    const req = http.request({
                        hostname: '127.0.0.1',
                        port: this.port,
                        path: '/',
                        method: 'HEAD', // 👈 Demande uniquement les en-têtes, pas les données
                        timeout: 2000
                    }, (res) => {
                        res.resume(); // Libère la mémoire (qui est déjà quasi vide car pas de body)
                        resolve(true);
                    });

                    // Échec de connexion (application non disponible)
                    req.on("error", () => resolve(false));

                    // Destruction immédiate en cas de timeout pour éviter les sockets fantômes
                    req.on("timeout", () => {
                        req.destroy();
                        resolve(false);
                    });

                    // Envoi de la requête
                    req.end();
                });

                if (result) return true;

                // Délai avant la prochaine tentative (si on n'est pas au dernier essai)
                if (retries < config.MAX_RETRIES - 1) {
                    await new Promise(resolve => setTimeout(resolve, config.RETRY_DELAY));
                }
            }
            return false;
        })();

        try {
            // On attend le résultat
            const isReady = await this.currentHealthCheckPromise;
            return isReady;
        } finally {
            // Nettoyage systématique du verrou à la fin des tests
            this.currentHealthCheckPromise = null;
        }
    }

    /**
     * Recherche de manière asynchrone un port réseau TCP libre sur la machine locale.
     */
    async findAvailablePort() {
        return await new Promise((resolve) => {
            const server = net.createServer();
            // Récupération du port courant du compteur global
            const currentPort = config.getNextPort();
            server.listen(currentPort, () => {
                server.close(() => {
                    // Le port est libre, on le retourne
                    resolve(currentPort);
                    // Incrémentation pour la prochaine recherche
                    config.incrementPort();
                });
            });
            server.on("error", () => {
                // Port occupé, incrémentation immédiate
                config.incrementPort();
                // Récursion pour tester le port suivant
                resolve(this.findAvailablePort());
            });
        });
    }

    /**
     * Exécute de manière générique une commande système et configure les flux de sortie.
     * Sécurisé contre les conflits de ports (EADDRINUSE) et crashs immédiats.
     */
    async executeServiceCommand(command, args, envOptions) {
        const port = await this.findAvailablePort();

        const env = Object.assign({}, process.env, envOptions, { PORT: port.toString() });
        const proc = child_process.spawn(command, args, { cwd: this.path, env });

        // Flag de sécurité pour suivre si le processus est toujours vivant
        let isProcessAlive = true;
        let processExitError = null;

        // Écoute des crashs systèmes ou de l'incapacité à lancer la commande
        proc.on("error", (err) => {
            isProcessAlive = false;
            processExitError = err;
            console.error(`[${this.name} CRITICAL] Le processus n'a pas pu démarrer: ${err.message}`);
        });

        // Écoute d'une fermeture précoce (ex: EADDRINUSE, erreur de syntaxe au boot)
        proc.on("exit", (code, signal) => {
            isProcessAlive = false;
            if (code !== 0 && code !== null) {
                processExitError = new Error(`Le processus s'est arrêté prématurément avec le code ${code}`);
            }
            console.log(`[${this.name} LOG] Le processus s'est arrêté (Code: ${code}, Signal: ${signal})`);
        });

        readline.createInterface({ input: proc.stdout }).on('line', (line) => {
            process.stdout.write(`[${this.name} LOG] ${line}\n`);
        });
        readline.createInterface({ input: proc.stderr }).on('line', (line) => {
            process.stderr.write(`[${this.name} ERR] ${line}\n`);
        });

        this.process = proc;
        this.port = port;
        this.status = "start";

        // Attente d'un signal HTTP positif mais en vérifiant que le process est vivant
        const ready = await new Promise(async (resolve) => {
            // Petit délai initial pour laisser au process le temps d'émettre un éventuel événement d'erreur/exit
            await new Promise(r => setTimeout(r, 100));

            if (!isProcessAlive) {
                resolve(false);
                return;
            }

            const isReady = await this.isAppReady();
            resolve(isReady);
        });

        // Si l'application n'est pas prête OU si le process est mort
        if (!ready || !isProcessAlive) {
            this.startPromise = null;

            if (!isProcessAlive) {
                // Le process a crashé (ex: port pris) -> On nettoie TOUT immédiatement sans background check
                this.status = "stopped";
                this.port = null;
                this.process = null;
                throw processExitError || new Error("L'application a crashé immédiatement au démarrage (Vérifiez les logs / Conflit de port)");
            } else {
                // Le process est vivant mais long à répondre -> On bascule en arrière-plan comme avant
                this.startBackgroundCheck();
                throw new Error("Application toujours en cours de chargement");
            }
        }

        // Confirmation de l'état actif
        this.status = "running";
        this.lastAccessed = Date.now();
        this.startPromise = null;
    }

    /**
     * Exécute une commande de build utilitaire (npm, venv, bash) et capte le code de sortie.
     */
    async runBuildCommand(command, args, options) {
        return new Promise((resolve) => {
            const proc = child_process.spawn(command, args, options);
            proc.stdout.on("data", (data) => { process.stdout.write(data); });
            proc.stderr.on("data", (data) => { process.stderr.write(data); });
            proc.on("close", (code) => { resolve(code == 0); });  // Renvoie vrai si code d'évitement 0
        });
    }

    /**
     * Lance une surveillance en arrière-plan pour confirmer le démarrage d'une application.
     */
    startBackgroundCheck() {
        let elapsed = 0;
        const interval = setInterval(async () => {
            elapsed += 1000;
            const ready = await this.isAppReady();

            if (ready) {
                clearInterval(interval);
                // Transition finale vers l'état actif
                this.status = "running";
                this.lastAccessed = Date.now();
                console.log(`[PROXY] App ${this.name} successfully started in background on port ${this.port}.`);
                return;
            }

            // Timeout de sécurité fixé à 30 secondes
            if (elapsed >= 30000) {
                clearInterval(interval);
                console.log(`[PROXY] App ${this.name} failed to start in background after 30 seconds. Killing.`);
                if (this.process) this.process.kill("SIGKILL");  // Arrêt forcé du sous-processus défaillant
                this.status = "stopped";
            }
        }, 1000);
    }

    async startApp() {
        throw new Error("La méthode startApp() doit être implémentée par les sous-classes.");
    }

    async buildApp() {
        throw new Error("La méthode buildApp() doit être implémentée par les sous-classes.");
    }

    async getOrStartApp() {
        if (this.status == "running") {
            // Mise à jour de l'activité
            this.lastAccessed = Date.now();
            return this;
        }

        // Retourne le verrou d'initialisation en cours
        if (this.startPromise) return this.startPromise;

        // Vérification si déjà en cycle de démarrage asynchrone
        if (this.status == "start") {
            const ready = await this.isAppReady();
            if (ready) {
                this.status = "running";
                this.lastAccessed = Date.now();
                return this;
            }
            throw new Error("Application toujours en cours de chargement");
        }

        // Déclenchement du processus d'initialisation
        // Si la promesse de démarrage rejette une erreur au premier boot,
        // on repasse immédiatement le verrou à null pour ne pas figer les requêtes suivantes.
        this.startPromise = this.startApp().catch((err) => {
            this.startPromise = null;
            throw err;
        });
        await this.startPromise;
        return this;
    }

    stopAppCleanly() {
        if (this.process) {
            // Signal de fermeture propre standard
            this.process?.kill("SIGTERM");
            setTimeout(() => {
                if (this.process?.exitCode == null) {
                    // Escalade vers un arrêt forcé après le délai de grâce
                    this.process?.kill("SIGKILL");
                }
            }, config.GRACE_PERIOD);
        }
        this.status = "stopped";
        this.port = null;
        this.process = null;
    }
}

module.exports = App;
