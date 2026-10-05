import http from "node:http";
import { createLogger } from "./logger.js";

const log = createLogger("server");

export interface ServerProviders {
  health: () => Promise<Record<string, unknown>>;
  stats: () => Promise<Record<string, unknown>>;
  positions: () => Promise<unknown>;
  trades: (limit: number) => Promise<unknown>;
  rankings: () => Promise<unknown>;
}

export function startServer(port: number, providers: ServerProviders): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
    };
    try {
      switch (url.pathname) {
        case "/health":
          send(200, await providers.health());
          break;
        case "/stats":
          send(200, await providers.stats());
          break;
        case "/positions":
          send(200, await providers.positions());
          break;
        case "/trades": {
          const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
          send(200, await providers.trades(limit));
          break;
        }
        case "/rankings":
          send(200, await providers.rankings());
          break;
        default:
          send(404, { error: "not found", routes: ["/health", "/stats", "/positions", "/trades?limit=N", "/rankings"] });
      }
    } catch (err) {
      log.error(`${req.method} ${url.pathname} failed: ${String(err)}`);
      send(500, { error: String(err) });
    }
  });

  server.listen(port, () => log.info(`HTTP listening on :${port}`));
  return server;
}
