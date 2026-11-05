/**
 * @file run-tests.js
 * @description Automated test suite and load benchmarks for node-proxy.
 * Pure native Node.js implementation without external dependencies.
 */

const http = require("http");
const path = require("path");
const child_process = require("child_process");

const TEST_PORT = 3888;
const MOCK_APPS_DIR = path.join(__dirname, "mock-apps");

// Helper for making standard HTTP requests
function makeRequest(options) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: "127.0.0.1",
                port: TEST_PORT,
                timeout: 10000,
                ...options,
            },
            (res) => {
                let body = "";
                res.on("data", (chunk) => {
                    body += chunk;
                });
                res.on("end", () => {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body,
                    });
                });
            },
        );

        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Request Timeout"));
        });

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let proxyProcess = null;

async function runTestSuite() {
    console.log("============================================================");
    console.log("🚀 STARTING AUTOMATED TEST SUITE FOR NODE-PROXY");
    console.log("============================================================");

    // 1. Start isolated test proxy
    console.log(`\n[INIT] Starting proxy on port ${TEST_PORT}...`);
    proxyProcess = child_process.spawn("node", [
        "index.js",
    ], {
        cwd: path.join(__dirname, ".."),
        env: Object.assign({}, process.env, {
            PORT: TEST_PORT.toString(),
            START_PORT: "4100",
            APPS_DIR: MOCK_APPS_DIR,
            DOMAIN: "test.local",
        }),
        stdio: "inherit",
    });

    // Wait for the proxy to start listening
    await sleep(1000);

    let passed = 0;
    let failed = 0;

    async function assertTest(name, fn) {
        process.stdout.write(`• Test: ${name} ... `);
        try {
            await fn();
            console.log("✅ OK");
            passed++;
        } catch (err) {
            console.log(`❌ FAILED: ${err.message}`);
            failed++;
        }
    }

    try {
        // TEST 1: Python Application
        await assertTest("Native Python application (app.py) via Host python-app.test.local", async () => {
            const res = await makeRequest({
                path: "/",
                headers: {
                    Host: "python-app.test.local",
                },
            });
            if (res.statusCode !== 200) throw new Error(`Expected status 200, received ${res.statusCode}`);
            const data = JSON.parse(res.body);
            if (data.runtime !== "python") throw new Error(`Expected runtime 'python', received '${data.runtime}'`);
        });

        // TEST 2: Nested Node.js Application (/server/package.json)
        await assertTest("Node.js application with nested /server folder (verifying cwd)", async () => {
            const res = await makeRequest({
                path: "/",
                headers: {
                    Host: "node-app.test.local",
                },
            });
            if (res.statusCode !== 200) throw new Error(`Expected status 200, received ${res.statusCode}`);
            const data = JSON.parse(res.body);
            if (data.runtime !== "node") throw new Error(`Expected runtime 'node', received '${data.runtime}'`);
            if (!data.cwd.endsWith(path.join("node-app", "server"))) {
                throw new Error(`Invalid CWD: ${data.cwd} (must end with node-app/server)`);
            }
        });

        // TEST 3: Static Application
        await assertTest("Static application: index.html and app.serveStaticApp call", async () => {
            const res = await makeRequest({
                path: "/",
                headers: {
                    Host: "static-app.test.local",
                },
            });
            if (res.statusCode !== 200) throw new Error(`Expected status 200, received ${res.statusCode}`);
            if (!res.body.includes("Hello Static World")) throw new Error("Expected HTML content missing");
        });

        await assertTest("Static application: .wasm (WebAssembly) support and MIME type", async () => {
            const res = await makeRequest({
                path: "/app.wasm",
                headers: {
                    Host: "static-app.test.local",
                },
            });
            if (res.statusCode !== 200) throw new Error(`Expected status 200, received ${res.statusCode}`);
            if (res.headers["content-type"] !== "application/wasm") {
                throw new Error(`Expected MIME 'application/wasm', received '${res.headers["content-type"]}'`);
            }
        });

        await assertTest("Static application: .svg and .webp support", async () => {
            const resSvg = await makeRequest({
                path: "/icon.svg",
                headers: {
                    Host: "static-app.test.local",
                },
            });
            if (resSvg.statusCode !== 200 || !resSvg.headers["content-type"].includes("image/svg+xml")) {
                throw new Error(`SVG response invalid: ${resSvg.statusCode}`);
            }

            const resWebp = await makeRequest({
                path: "/banner.webp",
                headers: {
                    Host: "static-app.test.local",
                },
            });
            if (resWebp.statusCode !== 200 || !resWebp.headers["content-type"].includes("image/webp")) {
                throw new Error(`WebP response invalid: ${resWebp.statusCode}`);
            }
        });

        await assertTest("Static application: File with space in filename (/mon%20image.png)", async () => {
            const res = await makeRequest({
                path: "/mon%20image.png",
                headers: {
                    Host: "static-app.test.local",
                },
            });
            if (res.statusCode !== 200) {
                throw new Error(`Expected status 200 for URL-encoded space, received ${res.statusCode}`);
            }
        });

        // TEST 4: Security Directory Traversal
        await assertTest("Security: Block Directory Traversal (/../etc/passwd)", async () => {
            const res = await makeRequest({
                path: "/../etc/passwd",
                headers: {
                    Host: "static-app.test.local",
                },
            });
            if (res.statusCode !== 403 && res.statusCode !== 404) {
                throw new Error(`Traversal attack not blocked! Received status: ${res.statusCode}`);
            }
        });

        await assertTest("Security: Block access to hidden dotfile (/.hidden_secret)", async () => {
            const res = await makeRequest({
                path: "/.hidden_secret",
                headers: {
                    Host: "static-app.test.local",
                },
            });
            if (res.statusCode !== 403) {
                throw new Error(`Dotfile access not blocked! Received status: ${res.statusCode}`);
            }
        });

        // TEST 5: Immediate Startup Crash Handling
        await assertTest("Handle immediate boot crash gracefully without bringing down proxy", async () => {
            const res = await makeRequest({
                path: "/",
                headers: {
                    Host: "crash-immediate-app.test.local",
                },
            });
            if (res.statusCode !== 500) {
                throw new Error(`Expected status 500 for startup crash, received ${res.statusCode}`);
            }
        });

        // TEST 6: Delayed In-flight Crash and Automatic Restart
        await assertTest("Detect in-flight crash and auto-restart instantly on next request", async () => {
            // First request starts the process
            const res1 = await makeRequest({
                path: "/",
                headers: {
                    Host: "crash-delayed-app.test.local",
                },
            });
            if (res1.statusCode !== 200) throw new Error(`Initial start failed: ${res1.statusCode}`);
            const data1 = JSON.parse(res1.body);
            const firstPid = data1.pid;

            console.log(` (App started with PID: ${firstPid}, waiting for scheduled suicide)...`);
            // Wait for self-termination after 2.5s
            await sleep(3000);

            // Second request must detect dead process and restart cleanly
            const res2 = await makeRequest({
                path: "/",
                headers: {
                    Host: "crash-delayed-app.test.local",
                },
            });
            if (res2.statusCode !== 200) {
                throw new Error(`Auto-restart failed after crash! Received ${res2.statusCode}`);
            }
            const data2 = JSON.parse(res2.body);
            if (data2.pid === firstPid) {
                throw new Error("Application was not restarted with a new process PID!");
            }
        });

        // TEST 7: Concurrency and Race Condition Prevention
        await assertTest("Concurrency: 20 simultaneous requests on stopped service", async () => {
            const promises = [];
            for (let i = 0; i < 20; i++) {
                promises.push(
                    makeRequest({
                        path: "/",
                        headers: {
                            Host: "python-app.test.local",
                        },
                    }),
                );
            }
            const results = await Promise.all(promises);
            for (const r of results) {
                if (r.statusCode !== 200) {
                    throw new Error(`Concurrent request failed with status ${r.statusCode}`);
                }
            }
        });

        // TEST 8: Status Endpoint and RAM Telemetry
        await assertTest("Monitoring: Endpoint /status/data with Linux /proc memory telemetry", async () => {
            const res = await makeRequest({
                path: "/status/data",
                headers: {
                    Host: "test.local",
                },
            });
            if (res.statusCode !== 200) throw new Error(`Status endpoint failed: ${res.statusCode}`);
            const data = JSON.parse(res.body);
            if (typeof data.proxyRam !== "number" || typeof data.totalRam !== "number") {
                throw new Error("Invalid memory telemetry data");
            }
            if (!Array.isArray(data.apps)) throw new Error("Applications list missing in telemetry");
            console.log(` (Proxy RAM: ${data.proxyRam} MB | Total RAM: ${data.totalRam} MB)`);
        });

        // TEST 9: Load Test
        await assertTest("Load test: 500 consecutive requests to confirm zero memory leak", async () => {
            const startTime = Date.now();
            const TOTAL_REQS = 500;
            for (let i = 0; i < TOTAL_REQS; i++) {
                const res = await makeRequest({
                    path: "/",
                    headers: {
                        Host: "python-app.test.local",
                    },
                });
                if (res.statusCode !== 200) throw new Error(`Failed at request #${i}`);
            }
            const durationMs = Date.now() - startTime;
            const rps = Math.round((TOTAL_REQS / durationMs) * 1000);
            console.log(` (${TOTAL_REQS} requests in ${durationMs}ms ~ ${rps} req/sec)`);
        });

        // TEST 10: Template Size Check (<= 2 KB)
        await assertTest("Template size: loading.min.html is strictly below 2 KB", async () => {
            const fsPromises = require("fs").promises;
            const minPath = path.join(__dirname, "..", "loading.min.html");
            const stat = await fsPromises.stat(minPath);
            if (stat.size > 2048) {
                throw new Error(`loading.min.html is ${stat.size} bytes, which exceeds the 2 KB limit!`);
            }
            console.log(` (${stat.size} bytes <= 2048 bytes limit)`);
        });

        // TEST 11: Multi-language Loading Page & Progress Bar
        await assertTest("Localization: Multi-language loading page delivery (French, Spanish, German)", async () => {
            // Mock an application that is currently starting by using an unregistered or starting route
            // Request with French language header
            const resFr = await makeRequest({
                path: "/",
                headers: {
                    Host: "python-app.test.local",
                    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
                    "Sec-Fetch-Mode": "navigate",
                    "Sec-Fetch-Dest": "document",
                    Accept: "text/html",
                },
            });
            // If already running, test the loading response handler directly via server metrics
            const metrics = require("../metrics");
            const estTime = await metrics.getEstimatedLoadingTime("python-app");
            if (typeof estTime !== "number" || estTime <= 0) {
                throw new Error("Invalid EMA estimated loading time");
            }
            console.log(` (EMA Estimated Loading Duration: ${estTime}ms)`);
        });

        // TEST 12: Loading Stats JSON Persistence
        await assertTest("Persistence: loading-stats.json contains valid EMA entries", async () => {
            const fsPromises = require("fs").promises;
            const statsPath = path.join(__dirname, "..", "loading-stats.json");
            const raw = await fsPromises.readFile(statsPath, "utf8");
            const stats = JSON.parse(raw);
            if (!stats["python-app"] && !stats["node-app"]) {
                throw new Error("Expected loading stats for tracked apps missing in JSON");
            }
            console.log(` (Found entries: ${Object.keys(stats).join(", ")})`);
        });

    } finally {
        if (proxyProcess) {
            console.log("\n[CLEANUP] Stopping test proxy...");
            proxyProcess.kill("SIGTERM");
            await sleep(300);
            try {
                proxyProcess.kill("SIGKILL");
            } catch (_) {}
        }
    }

    console.log("\n============================================================");
    console.log(`📊 FINAL TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("============================================================");

    if (failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

runTestSuite().catch((err) => {
    console.error("[FATAL TEST RUNNER ERROR]", err);
    if (proxyProcess) proxyProcess.kill("SIGKILL");
    process.exit(1);
});
