import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { WebSocketServer } from 'ws';
import { setupStreamingWebSocket } from './lib/assemblyai-streaming';
import { setupChunkTranscriptionWebSocket } from './lib/chunk-transcription';
import { setupListenerWebSockets } from './lib/listener-hub';
import { initGlossary } from './lib/glossary-store';

if (!process.env.OPENAI_API_KEY) {
  console.warn("Warning: OPENAI_API_KEY is not set — translation will fail");
}

const app = express();

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));

// Inject artificial latency on all /api routes when SIMULATE_LATENCY_MS is set.
// Simulates mobile upload delay + slower network round-trips during local dev.
// Example: set SIMULATE_LATENCY_MS=1500 in .env to emulate slow 4G conditions.
const _simDelay = parseInt(process.env.SIMULATE_LATENCY_MS || '0', 10);
if (_simDelay > 0) {
  log(`Latency simulation enabled: +${_simDelay}ms on all /api routes`);
  app.use('/api', (_req, _res, next) => setTimeout(next, _simDelay));
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

// initGlossary() never throws (see glossary-store.ts) but this stays
// belt-and-braces per repo style — a boot-time failure here must never
// prevent the server from starting.
try { initGlossary(); } catch (e) {
  console.warn('Glossary init failed — sermon mode will translate without a file glossary:', e);
}

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // Register the WebSocket upgrade handler BEFORE setupVite.
  // Vite registers its own HMR upgrade handler inside setupVite(); Node.js
  // fires 'upgrade' listeners in registration order, so registering ours first
  // ensures /ws/transcribe is claimed before Vite can intercept it and 404.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });
  setupStreamingWebSocket(wss);
  wss.on('error', (err) => { console.error('WebSocket server error:', err); });

  const wssChunk = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });
  setupChunkTranscriptionWebSocket(wssChunk);
  wssChunk.on('error', (err) => { console.error('Chunk WebSocket server error:', err); });

  // Listener mode (CLAUDE.md "Listener mode") — a separate WebSocketServer
  // per role (broadcaster vs. listener) rather than one server with a
  // type-switch on first message, matching the existing per-purpose split
  // above (plain transcribe vs. chunk-transcribe).
  const wssSermonBroadcast = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });
  const wssSermonListen = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });
  setupListenerWebSockets(wssSermonBroadcast, wssSermonListen);
  wssSermonBroadcast.on('error', (err) => { console.error('Sermon broadcast WebSocket server error:', err); });
  wssSermonListen.on('error', (err) => { console.error('Sermon listen WebSocket server error:', err); });

  server.on('upgrade', (req, socket, head) => {
    const pathname = req.url?.split('?')[0];
    if (pathname === '/ws/transcribe') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else if (pathname === '/ws/chunk-transcribe') {
      wssChunk.handleUpgrade(req, socket, head, (ws) => {
        wssChunk.emit('connection', ws, req);
      });
    } else if (pathname === '/ws/sermon-broadcast') {
      wssSermonBroadcast.handleUpgrade(req, socket, head, (ws) => {
        wssSermonBroadcast.emit('connection', ws, req);
      });
    } else if (pathname === '/ws/sermon-listen') {
      wssSermonListen.handleUpgrade(req, socket, head, (ws) => {
        wssSermonListen.emit('connection', ws, req);
      });
    }
    // All other upgrade requests (e.g. Vite HMR at /__vite_hmr) are left
    // untouched so Vite's handler (registered below) can claim them.
  });

  // Listener mode (CLAUDE.md "Listener mode"): exposing the server on the LAN
  // also exposes "/" and "/live" — the operator console, with recording
  // controls. A listener typing the bare IP with no path would otherwise land
  // there instead of the intended "/listen" view, and could accidentally
  // start a recording. Redirect exactly those two paths (never anything
  // else — assets, /api/*, and /listen itself are all untouched) to
  // "/listen" for any HTML navigation from a non-loopback address. The
  // operator's own MBP is always loopback, so this never affects them.
  // NOT an authentication boundary — see CLAUDE.md. Set
  // ALLOW_REMOTE_OPERATOR=true to disable (e.g. to run the console itself
  // from an iPad).
  function isLoopbackAddress(addr: string | undefined): boolean {
    if (!addr) return false;
    const stripped = addr.replace(/^::ffff:/, '');
    return stripped === '127.0.0.1' || stripped === '::1' || stripped === 'localhost';
  }
  if (process.env.ALLOW_REMOTE_OPERATOR !== 'true') {
    app.use((req, res, next) => {
      if (
        (req.path === '/' || req.path === '/live') &&
        !isLoopbackAddress(req.socket.remoteAddress) &&
        req.accepts('html')
      ) {
        return res.redirect(302, '/listen');
      }
      next();
    });
  }

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Serve the app on the port specified in the environment variable PORT
  // (defaults to 5001; see .env). This serves both the API and the client.
  const port = parseInt(process.env.PORT || '5001', 10);

  function startServer(retries = 5, delayMs = 1000) {
    // Use `once` so each listen attempt registers exactly one error handler.
    // With `on`, every retry would accumulate another handler on the same
    // server instance, causing multiple handlers to fire on the next error.
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && retries > 0) {
        // The server never started listening (port was held by another process),
        // so server.close() is not needed and would throw ERR_SERVER_NOT_RUNNING.
        log(`Port ${port} in use, retrying in ${delayMs}ms… (${retries} retries left)`);
        setTimeout(() => startServer(retries - 1, delayMs * 2), delayMs);
      } else {
        console.error('Fatal server error:', err);
        process.exit(1);
      }
    };

    server.once('error', onError);
    server.listen({ port, host: '0.0.0.0' }, () => {
      server.removeListener('error', onError);
      log(`serving on port ${port}`);
      log('WebSocket server ready for AssemblyAI real-time streaming transcription');
    });
  }

  startServer();
})();
