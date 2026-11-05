const http = require("http");
const port = parseInt(process.env.PORT, 10) || 8002;

const server = http.createServer((req, res) => {
  if (req.method === "HEAD") {
    res.writeHead(200);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "alive_temporarily", pid: process.pid, port }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[Crash Delayed App] Started on port ${port}, will intentionally suicide in 2.5 seconds...`);
  setTimeout(() => {
    console.log("[Crash Delayed App] 💥 Suicide trigger firing now!");
    process.exit(1);
  }, 2500);
});
