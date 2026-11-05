/**
 * @file status.js (Client-side)
 * @description Pure vanilla JavaScript interactive canvas chart engine and dashboard controller.
 * Zero external libraries (no Chart.js, no Alpine, no Tailwind).
 * Provides interactive zoomable time-series RAM graphs and application launch timelines.
 */

(function () {
    // Color palette for chart series
    const PALETTE = [
        "#38bdf8", // Sky blue (Proxy)
        "#34d399", // Emerald green (Total)
        "#fbbf24", // Amber (App 1)
        "#c084fc", // Purple (App 2)
        "#f43f5e", // Rose (App 3)
        "#a3e635", // Lime (App 4)
        "#22d3ee", // Cyan (App 5)
        "#e879f9", // Fuchsia (App 6)
        "#f97316", // Orange (App 7)
    ];

    /**
     * Formats timestamp into readable time string (HH:MM:SS).
     */
    function formatTime(ts) {
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        const ss = String(d.getSeconds()).padStart(2, "0");
        return `${hh}:${mm}:${ss}`;
    }

    /**
     * Formats seconds into human-readable duration string.
     */
    function formatUptime(sec) {
        if (!sec || isNaN(sec)) return "0s";
        const d = Math.floor(sec / 86400);
        const h = Math.floor((sec % 86400) / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        const parts = [];
        if (d > 0) parts.push(`${d}d`);
        if (h > 0) parts.push(`${h}h`);
        if (m > 0) parts.push(`${m}m`);
        parts.push(`${s}s`);
        return parts.join(" ");
    }

    /**
     * Interactive Zoomable HTML5 Canvas Time Series Chart.
     */
    class ZoomableRamChart {
        constructor(canvasId, tooltipId, legendId) {
            this.canvas = document.getElementById(canvasId);
            this.ctx = this.canvas.getContext("2d");
            this.tooltip = document.getElementById(tooltipId);
            this.legend = document.getElementById(legendId);

            this.data = []; // Array of { t, proxy, total, apps: { [name]: ram } }
            this.restarts = []; // Array of { timestamp, reason }
            this.seriesColors = new Map();
            this.hiddenSeries = new Set();

            // Zoom and Pan state
            this.userZoomed = false;
            this.viewStart = null;
            this.viewEnd = null;
            this.isDragging = false;
            this.dragStartX = 0;
            this.dragStartTime = 0;

            // Dimensions
            this.padding = { top: 20, right: 24, bottom: 30, left: 55 };

            this.initEvents();
            this.resize();
            window.addEventListener("resize", () => this.resize());
        }

        resize() {
            const rect = this.canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            this.canvas.width = rect.width * dpr;
            this.canvas.height = rect.height * dpr;
            this.ctx.scale(dpr, dpr);
            this.draw();
        }

        initEvents() {
            // Wheel zoom
            this.canvas.addEventListener("wheel", (e) => {
                e.preventDefault();
                if (this.data.length < 2) return;

                const bounds = this.getEffectiveBounds();
                const totalSpan = bounds.maxT - bounds.minT;
                if (totalSpan <= 0) return;

                const rect = this.canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left - this.padding.left;
                const plotWidth = rect.width - this.padding.left - this.padding.right;
                const ratio = Math.max(0, Math.min(1, mouseX / plotWidth));

                const currentMin = this.viewStart !== null ? this.viewStart : bounds.minT;
                const currentMax = this.viewEnd !== null ? this.viewEnd : bounds.maxT;
                const currentSpan = currentMax - currentMin;

                const zoomFactor = e.deltaY < 0 ? 0.8 : 1.25;
                const newSpan = Math.max(10000, Math.min(totalSpan * 1.5, currentSpan * zoomFactor));

                const anchorTime = currentMin + currentSpan * ratio;
                this.viewStart = anchorTime - newSpan * ratio;
                this.viewEnd = this.viewStart + newSpan;
                this.userZoomed = true;

                this.draw();
                if (window.onChartZoom) window.onChartZoom(this.viewStart, this.viewEnd);
            }, { passive: false });

            // Mouse drag / pan
            this.canvas.addEventListener("mousedown", (e) => {
                this.isDragging = true;
                this.dragStartX = e.clientX;
                const bounds = this.getEffectiveBounds();
                this.dragStartMin = this.viewStart !== null ? this.viewStart : bounds.minT;
                this.dragStartMax = this.viewEnd !== null ? this.viewEnd : bounds.maxT;
            });

            window.addEventListener("mousemove", (e) => {
                if (this.isDragging) {
                    const rect = this.canvas.getBoundingClientRect();
                    const plotWidth = rect.width - this.padding.left - this.padding.right;
                    const dx = e.clientX - this.dragStartX;
                    const span = this.dragStartMax - this.dragStartMin;
                    const dt = -(dx / plotWidth) * span;

                    this.viewStart = this.dragStartMin + dt;
                    this.viewEnd = this.dragStartMax + dt;
                    this.userZoomed = true;

                    this.draw();
                    if (window.onChartZoom) window.onChartZoom(this.viewStart, this.viewEnd);
                } else {
                    this.handleHover(e);
                }
            });

            window.addEventListener("mouseup", () => {
                this.isDragging = false;
            });

            this.canvas.addEventListener("mouseleave", () => {
                this.tooltip.style.display = "none";
                this.draw();
            });
        }

        handleHover(e) {
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            if (
                mouseX < this.padding.left ||
                mouseX > rect.width - this.padding.right ||
                mouseY < this.padding.top ||
                mouseY > rect.height - this.padding.bottom
            ) {
                this.tooltip.style.display = "none";
                this.draw();
                return;
            }

            const bounds = this.getEffectiveBounds();
            const minT = this.viewStart !== null ? this.viewStart : bounds.minT;
            const maxT = this.viewEnd !== null ? this.viewEnd : bounds.maxT;
            const plotWidth = rect.width - this.padding.left - this.padding.right;

            const tAtMouse = minT + ((mouseX - this.padding.left) / plotWidth) * (maxT - minT);

            // Find closest data point
            let closest = null;
            let minDiff = Infinity;
            for (const pt of this.data) {
                const diff = Math.abs(pt.t - tAtMouse);
                if (diff < minDiff) {
                    minDiff = diff;
                    closest = pt;
                }
            }

            if (!closest) {
                this.tooltip.style.display = "none";
                return;
            }

            this.draw(closest.t);

            // Populate tooltip
            let html = `<strong>${formatTime(closest.t)}</strong><br>`;
            if (!this.hiddenSeries.has("Proxy RAM")) {
                html += `<span style="color:#38bdf8">■</span> Proxy RAM: ${closest.proxy} MB<br>`;
            }
            if (!this.hiddenSeries.has("Total RAM")) {
                html += `<span style="color:#34d399">■</span> Total RAM: ${closest.total} MB<br>`;
            }

            for (const [appName, ramVal] of Object.entries(closest.apps || {})) {
                if (!this.hiddenSeries.has(appName)) {
                    const color = this.seriesColors.get(appName) || "#ccc";
                    html += `<span style="color:${color}">■</span> ${appName}: ${ramVal} MB<br>`;
                }
            }

            this.tooltip.innerHTML = html;
            this.tooltip.style.display = "block";
            this.tooltip.style.left = `${Math.min(rect.width - 160, Math.max(10, mouseX + 15))}px`;
            this.tooltip.style.top = `${Math.min(rect.height - 80, Math.max(10, mouseY - 20))}px`;
        }

        getEffectiveBounds() {
            if (this.data.length === 0) {
                const now = Date.now();
                return { minT: now - 60000, maxT: now, maxVal: 100 };
            }
            const minT = this.data[0].t;
            const maxT = this.data[this.data.length - 1].t;
            let maxVal = 50;

            for (const pt of this.data) {
                if (!this.hiddenSeries.has("Total RAM") && pt.total > maxVal) maxVal = pt.total;
                if (!this.hiddenSeries.has("Proxy RAM") && pt.proxy > maxVal) maxVal = pt.proxy;
                for (const [app, v] of Object.entries(pt.apps || {})) {
                    if (!this.hiddenSeries.has(app) && v > maxVal) maxVal = v;
                }
            }

            return { minT, maxT, maxVal: Math.ceil((maxVal * 1.15) / 10) * 10 };
        }

        setData(data, restarts = []) {
            this.data = data || [];
            this.restarts = restarts || [];
            this.ensureColors();
            this.updateLegend();
            this.draw();
        }

        ensureColors() {
            this.seriesColors.set("Proxy RAM", PALETTE[0]);
            this.seriesColors.set("Total RAM", PALETTE[1]);
            let pIdx = 2;

            for (const pt of this.data) {
                for (const app of Object.keys(pt.apps || {})) {
                    if (!this.seriesColors.has(app)) {
                        this.seriesColors.set(app, PALETTE[pIdx % PALETTE.length]);
                        pIdx++;
                    }
                }
            }
        }

        updateLegend() {
            if (!this.legend) return;
            let html = "";
            for (const [seriesName, color] of this.seriesColors.entries()) {
                const isHidden = this.hiddenSeries.has(seriesName);
                const opacity = isHidden ? "0.35" : "1";
                html += `<div class="legend-item" style="opacity:${opacity}" data-series="${seriesName}">
                    <span class="legend-color" style="background:${color}"></span>
                    <span>${seriesName}</span>
                </div>`;
            }
            this.legend.innerHTML = html;

            this.legend.querySelectorAll(".legend-item").forEach((el) => {
                el.onclick = () => {
                    const name = el.getAttribute("data-series");
                    if (this.hiddenSeries.has(name)) this.hiddenSeries.delete(name);
                    else this.hiddenSeries.add(name);
                    this.updateLegend();
                    this.draw();
                };
            });
        }

        zoomPreset(durationMs) {
            if (this.data.length === 0) return;
            const maxT = this.data[this.data.length - 1].t;
            if (durationMs === null) {
                // Reset zoom to all data
                this.viewStart = null;
                this.viewEnd = null;
                this.userZoomed = false;
            } else {
                this.viewEnd = maxT;
                this.viewStart = maxT - durationMs;
                this.userZoomed = true;
            }
            this.draw();
            if (window.onChartZoom) window.onChartZoom(this.viewStart, this.viewEnd);
        }

        draw(crosshairTime = null) {
            const rect = this.canvas.getBoundingClientRect();
            const w = rect.width;
            const h = rect.height;
            const ctx = this.ctx;

            ctx.clearRect(0, 0, w, h);

            if (this.data.length === 0) {
                ctx.fillStyle = "#64748b";
                ctx.font = "12px sans-serif";
                ctx.textAlign = "center";
                ctx.fillText("Awaiting telemetry data...", w / 2, h / 2);
                return;
            }

            const bounds = this.getEffectiveBounds();
            const minT = this.viewStart !== null ? this.viewStart : bounds.minT;
            const maxT = this.viewEnd !== null ? this.viewEnd : bounds.maxT;
            const maxVal = bounds.maxVal;

            const plotW = w - this.padding.left - this.padding.right;
            const plotH = h - this.padding.top - this.padding.bottom;

            const getX = (t) => this.padding.left + ((t - minT) / (maxT - minT)) * plotW;
            const getY = (v) => this.padding.top + plotH - (v / maxVal) * plotH;

            // Draw Y-axis grid lines and labels
            ctx.strokeStyle = "#1e293b";
            ctx.fillStyle = "#64748b";
            ctx.font = "10px sans-serif";
            ctx.textAlign = "right";

            const ySteps = 4;
            for (let i = 0; i <= ySteps; i++) {
                const val = Math.round((maxVal / ySteps) * i);
                const y = getY(val);
                ctx.beginPath();
                ctx.moveTo(this.padding.left, y);
                ctx.lineTo(w - this.padding.right, y);
                ctx.stroke();
                ctx.fillText(`${val} MB`, this.padding.left - 8, y + 3);
            }

            // Draw X-axis time labels
            ctx.textAlign = "center";
            const xSteps = 5;
            for (let i = 0; i <= xSteps; i++) {
                const t = minT + ((maxT - minT) / xSteps) * i;
                const x = getX(t);
                ctx.fillText(formatTime(t), x, h - 8);
            }

            // Draw Restarts vertical lines
            for (const r of this.restarts) {
                if (r.timestamp >= minT && r.timestamp <= maxT) {
                    const rx = getX(r.timestamp);
                    ctx.save();
                    ctx.setLineDash([4, 4]);
                    ctx.strokeStyle = "#f43f5e";
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(rx, this.padding.top);
                    ctx.lineTo(rx, h - this.padding.bottom);
                    ctx.stroke();

                    ctx.fillStyle = "#f43f5e";
                    ctx.font = "bold 9px sans-serif";
                    ctx.fillText("REBOOT", rx, this.padding.top - 5);
                    ctx.restore();
                }
            }

            // Render series lines
            const drawLine = (seriesName, color, valExtractor) => {
                if (this.hiddenSeries.has(seriesName)) return;

                ctx.save();
                ctx.beginPath();
                let started = false;

                for (const pt of this.data) {
                    const v = valExtractor(pt);
                    if (v === null || isNaN(v)) continue;
                    const x = getX(pt.t);
                    const y = getY(v);

                    if (!started) {
                        ctx.moveTo(x, y);
                        started = true;
                    } else {
                        ctx.lineTo(x, y);
                    }
                }

                ctx.strokeStyle = color;
                ctx.lineWidth = seriesName === "Total RAM" ? 2.5 : 1.8;
                ctx.stroke();
                ctx.restore();
            };

            // Draw apps lines
            for (const [appName, color] of this.seriesColors.entries()) {
                if (appName === "Proxy RAM" || appName === "Total RAM") continue;
                drawLine(appName, color, (pt) => (pt.apps && pt.apps[appName] !== undefined ? pt.apps[appName] : null));
            }

            // Draw Proxy & Total RAM lines
            drawLine("Proxy RAM", PALETTE[0], (pt) => pt.proxy);
            drawLine("Total RAM", PALETTE[1], (pt) => pt.total);

            // Draw Crosshair on hover
            if (crosshairTime && crosshairTime >= minT && crosshairTime <= maxT) {
                const cx = getX(crosshairTime);
                ctx.save();
                ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(cx, this.padding.top);
                ctx.lineTo(cx, h - this.padding.bottom);
                ctx.stroke();
                ctx.restore();
            }
        }
    }

    /**
     * Interactive Zoomable Gantt Timeline Chart for Application Launch Periods.
     */
    class AppTimelineChart {
        constructor(canvasId, tooltipId) {
            this.canvas = document.getElementById(canvasId);
            this.ctx = this.canvas.getContext("2d");
            this.tooltip = document.getElementById(tooltipId);

            this.events = [];
            this.viewStart = null;
            this.viewEnd = null;
            this.padding = { top: 20, right: 24, bottom: 25, left: 110 };

            this.resize();
            window.addEventListener("resize", () => this.resize());
        }

        resize() {
            const rect = this.canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            this.canvas.width = rect.width * dpr;
            this.canvas.height = rect.height * dpr;
            this.ctx.scale(dpr, dpr);
            this.draw();
        }

        setData(events) {
            this.events = events || [];
            this.draw();
        }

        setTimeBounds(start, end) {
            this.viewStart = start;
            this.viewEnd = end;
            this.draw();
        }

        draw() {
            const rect = this.canvas.getBoundingClientRect();
            const w = rect.width;
            const h = rect.height;
            const ctx = this.ctx;

            ctx.clearRect(0, 0, w, h);

            // Collect unique applications
            const appsSet = new Set();
            for (const ev of this.events) appsSet.add(ev.app);
            const appList = Array.from(appsSet);

            if (appList.length === 0) {
                ctx.fillStyle = "#64748b";
                ctx.font = "12px sans-serif";
                ctx.textAlign = "center";
                ctx.fillText("No application activity recorded yet.", w / 2, h / 2);
                return;
            }

            const now = Date.now();
            const minT = this.viewStart !== null ? this.viewStart : (this.events[0]?.timestamp || now - 60000);
            const maxT = this.viewEnd !== null ? this.viewEnd : now;

            const plotW = w - this.padding.left - this.padding.right;
            const rowHeight = Math.min(28, (h - this.padding.top - this.padding.bottom) / appList.length);

            const getX = (t) => this.padding.left + ((t - minT) / (maxT - minT)) * plotW;

            // Draw time axis grid
            ctx.strokeStyle = "#1e293b";
            ctx.fillStyle = "#64748b";
            ctx.font = "10px sans-serif";
            ctx.textAlign = "center";

            for (let i = 0; i <= 5; i++) {
                const t = minT + ((maxT - minT) / 5) * i;
                const x = getX(t);
                ctx.beginPath();
                ctx.moveTo(x, this.padding.top);
                ctx.lineTo(x, h - this.padding.bottom);
                ctx.stroke();
                ctx.fillText(formatTime(t), x, h - 6);
            }

            // Draw rows and spans for each app
            appList.forEach((appName, idx) => {
                const y = this.padding.top + idx * rowHeight;

                // Row label
                ctx.fillStyle = "#94a3b8";
                ctx.font = "11px sans-serif";
                ctx.textAlign = "right";
                ctx.fillText(appName, this.padding.left - 12, y + rowHeight / 2 + 4);

                // Row separator
                ctx.strokeStyle = "#1e293b";
                ctx.beginPath();
                ctx.moveTo(this.padding.left, y + rowHeight);
                ctx.lineTo(w - this.padding.right, y + rowHeight);
                ctx.stroke();

                // Build state spans for this app
                const appEvs = this.events.filter((e) => e.app === appName).sort((a, b) => a.timestamp - b.timestamp);

                for (let i = 0; i < appEvs.length; i++) {
                    const ev = appEvs[i];
                    const nextEv = appEvs[i + 1];
                    const startTime = ev.timestamp;
                    const endTime = nextEv ? nextEv.timestamp : now;

                    if (endTime < minT || startTime > maxT) continue;

                    const sx = Math.max(this.padding.left, getX(startTime));
                    const ex = Math.min(w - this.padding.right, getX(endTime));
                    const barW = Math.max(2, ex - sx);

                    let color = "#64748b"; // stopped
                    if (ev.event === "running") color = "#34d399";
                    else if (ev.event === "start") color = "#fbbf24";
                    else if (ev.event === "crash") color = "#f43f5e";

                    ctx.fillStyle = color;
                    ctx.fillRect(sx, y + 4, barW, rowHeight - 8);
                }
            });
        }
    }

    // Dashboard Controller & Initialization
    let ramChart = null;
    let timelineChart = null;

    async function fetchAndUpdate() {
        try {
            const res = await fetch("/status/data", { cache: "no-store" });
            if (res.status === 401) {
                // Session expired or unauthenticated
                window.location.reload();
                return;
            }
            const data = await res.json();

            // Update KPI counters
            document.getElementById("kpiProxyRam").textContent = `${data.proxyRam} MB`;
            document.getElementById("kpiTotalRam").textContent = `${data.totalRam} MB`;
            document.getElementById("kpiUptime").textContent = formatUptime(data.uptimeSeconds);
            document.getElementById("kpiActiveApps").textContent = data.apps.filter((a) => a.status === "running").length;

            // Update Charts
            if (ramChart) ramChart.setData(data.ramHistory, data.restarts);
            if (timelineChart) timelineChart.setData(data.appEvents);

            // Update Applications Table
            const tbody = document.getElementById("appsTableBody");
            if (tbody) {
                let html = "";
                for (const app of data.apps) {
                    let badgeClass = "badge-stopped";
                    if (app.status === "running") badgeClass = "badge-running";
                    else if (app.status === "start") badgeClass = "badge-start";

                    html += `<tr>
                        <td><strong>${app.name}</strong></td>
                        <td>${app.type}</td>
                        <td><span class="badge ${badgeClass}">${app.status}</span></td>
                        <td>${app.port}</td>
                        <td>${app.ram !== "-" ? app.ram + " MB" : "-"}</td>
                    </tr>`;
                }
                tbody.innerHTML = html;
            }

            // Update Restarts List
            const restartsList = document.getElementById("restartsList");
            if (restartsList && Array.isArray(data.restarts)) {
                let html = "";
                const reversed = [...data.restarts].reverse();
                for (const r of reversed.slice(0, 10)) {
                    const d = new Date(r.timestamp);
                    html += `<li class="restart-item">
                        <div>
                            <div class="restart-meta">Proxy Reboot</div>
                            <div class="restart-date">${d.toLocaleDateString()} ${d.toLocaleTimeString()}</div>
                        </div>
                        <span class="restart-badge">PID Active</span>
                    </li>`;
                }
                restartsList.innerHTML = html || "<li class='restart-item'>No previous restarts.</li>";
            }
        } catch (_) {}
    }

    window.addEventListener("DOMContentLoaded", () => {
        ramChart = new ZoomableRamChart("ramChart", "chartTooltip", "chartLegend");
        timelineChart = new AppTimelineChart("timelineChart", "chartTooltip");

        // Synchronize charts on zoom
        window.onChartZoom = (start, end) => {
            if (timelineChart) timelineChart.setTimeBounds(start, end);
        };

        // Preset zoom buttons
        document.querySelectorAll("[data-zoom]").forEach((btn) => {
            btn.onclick = () => {
                document.querySelectorAll("[data-zoom]").forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                const val = btn.getAttribute("data-zoom");
                if (val === "5m") ramChart.zoomPreset(5 * 60 * 1000);
                else if (val === "15m") ramChart.zoomPreset(15 * 60 * 1000);
                else if (val === "1h") ramChart.zoomPreset(60 * 60 * 1000);
                else ramChart.zoomPreset(null);
            };
        });

        // Initial fetch and 3s interval
        fetchAndUpdate();
        setInterval(fetchAndUpdate, 3000);
    });
})();
