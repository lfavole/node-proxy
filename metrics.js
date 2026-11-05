/**
 * @file metrics.js
 * @description Asynchronous loading duration tracker using Exponential Moving Average (EMA).
 * Persists timings in loading-stats.json asynchronously without blocking disk I/O.
 */

const fs = require("fs").promises;
const path = require("path");

const STATS_FILE = path.join(__dirname, "loading-stats.json");
// Default estimated startup time in milliseconds for unknown applications
const DEFAULT_ESTIMATED_MS = 3000;
// Smoothing factor for Exponential Moving Average (EMA)
const EMA_ALPHA = 0.3;

// In-memory cache for instant zero-I/O access
let statsCache = null;
let isWriting = false;

/**
 * Loads cached statistics asynchronously.
 */
async function loadStats() {
    if (statsCache !== null) {
        return statsCache;
    }

    try {
        const raw = await fs.readFile(STATS_FILE, "utf8");
        statsCache = JSON.parse(raw);
    } catch {
        // Fallback to empty metrics table if file does not exist or is invalid
        statsCache = {};
    }
    return statsCache;
}

/**
 * Retrieves the estimated loading duration in milliseconds for an application.
 */
async function getEstimatedLoadingTime(appName) {
    const stats = await loadStats();
    const entry = stats[appName];
    if (entry && typeof entry.emaMs === "number" && entry.emaMs > 200) {
        return Math.min(entry.emaMs, 60000);
    }
    return DEFAULT_ESTIMATED_MS;
}

/**
 * Records a cold start duration and updates the Exponential Moving Average.
 */
async function recordLoadingDuration(appName, durationMs) {
    if (durationMs <= 0) return;
    const stats = await loadStats();
    const previous = stats[appName];

    let newEma;
    let sampleCount;

    if (previous && typeof previous.emaMs === "number") {
        // Calculate Exponential Moving Average: EMA = alpha * sample + (1 - alpha) * previous_EMA
        newEma = Math.round(EMA_ALPHA * durationMs + (1 - EMA_ALPHA) * previous.emaMs);
        sampleCount = (previous.samples || 1) + 1;
    } else {
        newEma = Math.round(durationMs);
        sampleCount = 1;
    }

    stats[appName] = {
        emaMs: newEma,
        lastMs: Math.round(durationMs),
        samples: sampleCount,
        updatedAt: new Date().toISOString(),
    };

    // Asynchronous non-blocking file write
    if (!isWriting) {
        isWriting = true;
        try {
            await fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 4), "utf8");
        } catch (err) {
            console.error(`[METRICS ERROR] Failed saving loading stats: ${err.message}`);
        } finally {
            isWriting = false;
        }
    }
}

module.exports = {
    getEstimatedLoadingTime,
    recordLoadingDuration,
};
