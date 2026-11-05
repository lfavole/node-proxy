# Node Proxy 🚀

An autonomous, ultra-lightweight reverse proxy gateway designed to orchestrate and multiplex Node.js, Python, and static HTML web applications on a single server with zero external dependencies.

---

## ⚡ Memory Optimization: Lowering RAM Usage Below 59 MB

By default, Node.js allocates ~50–60 MB of Resident Set Size (RSS) because the V8 engine pre-allocates memory for young generation semi-spaces (nursery), JIT compiler bytecode optimizations, and glibc multi-threaded memory arenas.

Because **node-proxy** acts as a high-throughput network stream multiplexer (using native C++ HTTP/net stream pipelines) without running CPU-heavy computational algorithms, you can safely constrain V8 heap and compiler allocations to reduce memory consumption down to **~20–30 MB**.

### 1. Recommended Production Command (~30–35 MB RAM)
```bash
node --optimize-for-size --max-old-space-size=48 --max-semi-space-size=1 index.js
```
- `--optimize-for-size`: Informs V8 to favor small memory footprint over speculative compiler tiering.
- `--max-old-space-size=48`: Caps old generation heap before triggering garbage collection compaction.
- `--max-semi-space-size=1`: Reduces V8 young-generation nursery buffers from 16 MB down to 1 MB.

### 2. Ultra-Low RAM Mode with glibc Arena Tuning (~22–28 MB RAM)
On Linux servers (glibc), multi-core systems spawn multiple `malloc` memory arenas that consume virtual pages. Limiting arenas saves up to 15 MB:
```bash
MALLOC_ARENA_MAX=2 node --optimize-for-size --max-old-space-size=32 --max-semi-space-size=1 --expose-gc index.js
```

### 3. Pure Streaming Zero-JIT Mode (~18–24 MB RAM)
For headless reverse proxying where all request/response bodies are piped directly via native streams:
```bash
node --jitless --max-old-space-size=32 index.js
```

### 4. Running via npm scripts or systemd
You can configure `NODE_OPTIONS` directly in your environment or service file:
```bash
export NODE_OPTIONS="--optimize-for-size --max-old-space-size=48 --max-semi-space-size=1"
npm start
```

---

## 🌐 Dedicated Domain & Subdomain Routing

The proxy supports running applications on **both subdomains and dedicated full domains**:

| Scenario | Incoming Host | Target Folder / Resolution |
| :--- | :--- | :--- |
| **Subdomain** | `blog.lfavole.fr` | Looks for folder `blog` |
| **Dedicated Domain (Folder name)** | `example.com` | Looks for folder `example.com` |
| **Dedicated Domain (Mapping)** | `mysite.org` | Mapped via `DOMAIN_MAPPINGS="mysite.org:node-app"` |
| **TLD Stripping Fallback** | `portfolio.fr` | Matches folder `portfolio` if `portfolio.fr` does not exist |
| **Apex / Root Domain** | `lfavole.fr` | Matches `DEFAULT_APP` or folder `www` / `root` |
| **Local Development** | `app.localhost` | Matches folder `app` |

### Configuring Dedicated Domains via `.env`
```env
# Comma-separated pairs
DOMAIN_MAPPINGS=example.com:node-app,client.fr:python-app,docs.org:static-app

# Or JSON format
DOMAIN_MAPPINGS={"example.com":"node-app","client.fr":"python-app"}
```

---

## 🔒 Password-Protected Status Dashboard & Zoomable Telemetry

The status page is available at `/status` (or `status.<domain>`):
- **Password Protection**: Set `STATUS_PASSWORD=your_password` in `.env`.
- **Authentication**: Supports both a sleek web login interface (with secure HTTP-only session cookie) and standard HTTP Basic Authentication (`Authorization: Basic ...`) for automated scripts.
- **Interactive Zoomable Canvas Charts**:
  - **RAM Usage Evolution**: Real-time multi-series line chart tracking Main Proxy RAM, Total System RAM, and individual app RAM.
  - **Zoom & Pan**: Use the mouse wheel to zoom in/out on the time axis, or click and drag horizontally to scrub through history. Includes preset buttons (`[5 min]`, `[15 min]`, `[1 hour]`, `[All]`).
  - **Application Launch Periods**: Interactive Gantt-style timeline displaying application states over time (Starting = Amber, Running = Green, Crash = Red, Stopped = Gray).
  - **Proxy Restarts**: Red dashed markers indicating exact proxy reboot events, plus a dedicated restart history panel.
- **Zero External Dependencies**: Built with native HTML5 Canvas, modern CSS, and vanilla JavaScript (no Chart.js, no Alpine, no Tailwind).

---

## ⚙️ Configuration (`.env.example`)

Copy `.env.example` to `.env` to configure the proxy:

```env
PORT=3000
DOMAIN=lfavole.fr
DEFAULT_APP=my-main-app
STATUS_PASSWORD=admin
APPS_DIR=..
START_PORT=3001
IDLE_TIMEOUT=300000
HEALTH_CHECK_INTERVAL=300000
GRACE_PERIOD=15000
DOMAIN_MAPPINGS=example.com:node-app,my-site.fr:static-app
```

---

## 🧪 Automated Test Suite

Run the full end-to-end integration and load test suite:
```bash
npm test
```
The suite verifies:
- Python and Node.js nested application proxying
- Dedicated domain and subdomain routing
- Static asset delivery with exotic MIME types (`.wasm`, `.svg`, `.webp`)
- Directory traversal and dotfile security containment
- Crash resilience (immediate boot crash and delayed in-flight crash recovery)
- Concurrent requests and zero-leak memory load tests
- Status password authentication and historical telemetry persistence
