import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { WebSocketServer } from 'ws';
import { setupChunkTranscriptionWebSocket } from './lib/chunk-transcription';

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

(async () => {
  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);

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
      // Success — remove the error handler so it doesn't linger
      server.removeListener('error', onError);
      log(`serving on port ${port}`);

      // noServer mode: the WSS never attaches its own 'upgrade' listener to the
      // http server, so it never calls abortHandshake() on requests that don't
      // match our path. Without this, the ws library sends HTTP 400 + destroys
      // the socket for every non-matching upgrade (including Vite's HMR
      // connections), which corrupts the already-established HMR WebSocket and
      // produces "Invalid frame header" in the browser.
      const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });
      setupChunkTranscriptionWebSocket(wss);
      wss.on('error', (err) => {
        console.error('WebSocket server error:', err);
      });

      // Manually route only /ws/transcribe upgrades to our WSS.
      // All other upgrade requests (Vite HMR at /) are left untouched.
      server.on('upgrade', (req, socket, head) => {
        const pathname = req.url?.split('?')[0];
        if (pathname === '/ws/transcribe') {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
          });
        }
      });

      log('WebSocket server set up for chunk-based transcription');
    });
  }

  startServer();
})();
