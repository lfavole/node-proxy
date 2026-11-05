const http = require("http");
const port = parseInt(process.env.PORT, 10) || 8001;

const server = http.createServer((req, res) => {
  if (req.method === "HEAD") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    runtime: "node",
    cwd: process.cwd(),
    port
  }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[Nested Node App] Listening on port ${port} from cwd: ${process.cwd()}`);
});
