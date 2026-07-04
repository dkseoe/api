#!/usr/bin/env node
// HTTP server entrypoint: routes requests to the gateway handlers.
//
//   GET  /v1/models        -> aggregated model list pulled from all upstreams
//   GET  /healthz          -> liveness probe (no upstream calls)
//   ALL  /*                -> reverse-proxy to upstream(s) with failover

import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { UpstreamPool } from './upstreams.js';
import { Semaphore } from './concurrency.js';
import { proxyRequest } from './proxy.js';
import { sendJson, wantsPretty } from './util.js';
import { log, addSink } from './logger.js';
import { audit } from './auditlog.js';
import { STATUS_HTML } from './dashboard.js';

function authed(config, req) {
  if (!config.gatewayApiKey) return true;
  const header = req.headers.authorization || '';
  const expected = `Bearer ${config.gatewayApiKey}`;
  // Constant-time-ish comparison.
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function createGateway(config) {
  const pool = new UpstreamPool({
    upstreams: config.upstreams,
    maxConcurrencyPerUpstream: config.maxConcurrencyPerUpstream,
    upstreamRequestTimeoutMs: config.upstreamRequestTimeoutMs,
    modelsCacheTtlMs: config.modelsCacheTtlMs,
    modelsPath: config.modelsPath,
  });
  const totalLimiter = new Semaphore(config.maxConcurrencyTotal);

  // Mirror structured logs into the audit log for the dashboard.
  addSink((e) => audit.addLog(e));

  const server = createServer((req, res) => {
    // Knock-out for total concurrency before any work begins.
    totalLimiter.acquire().then(handle).catch((err) => {
      log.error('dispatch error', err);
      if (!res.headersSent) sendJson(res, 500, { error: { message: 'internal error' } });
      try { res.end(); } catch {}
    });

    function handle() {
      Promise.resolve()
        .then(async () => {
          // Status dashboard + JSON API.
          if (req.method === 'GET' && (req.url === '/' || req.url === '/status')) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(STATUS_HTML);
            return;
          }
          if (req.method === 'GET' && req.url.startsWith('/__status')) {
            sendJson(res, 200, audit.snapshot({
              upstreams: config.upstreams.map((u) => ({ id: u.id, baseUrl: u.baseUrl })),
              models: pool._modelsCache?.value?.data?.length ?? null,
              promptCache: { inject: config.promptCacheInject, ttl: config.promptCacheTtl, sticky: config.promptCacheSticky },
            }));
            return;
          }

          if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
            sendJson(res, 200, { status: 'ok', upstreams: config.upstreams.length });
            return;
          }

          if (!authed(config, req)) {
            sendJson(res, 401, { error: { message: 'invalid gateway credentials', type: 'auth_error' } });
            return;
          }

          // Model list endpoint — pulled (and cached) from upstreams.
          if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
            try {
              const list = await pool.getModels();
              sendJson(res, 200, list, config.prettyJson && wantsPretty(req));
            } catch (err) {
              sendJson(res, 502, { error: { message: err.message, type: 'gateway_models_error' } });
            }
            return;
          }

          // Everything else is reverse-proxied.
          await proxyRequest(req, res, pool, config);
        })
        .catch((err) => {
          log.error('handler error', { url: req.url, method: req.method, err });
          if (!res.headersSent) {
            sendJson(res, 500, { error: { message: err.message || 'internal error' } });
          }
          try { res.end(); } catch {}
        })
        .finally(() => totalLimiter.release());
    }
  });

  // Squash lingering sockets so the process can exit promptly on SIGTERM.
  server.on('connection', (socket) => {
    socket.setTimeout(0);
  });

  return { server, pool, config };
}

async function main() {
  const config = loadConfig();
  const { server } = createGateway(config);
  server.on('error', (err) => {
    log.error('server error', err);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    log.info('gateway listening', {
      host: config.host,
      port: config.port,
      upstreams: config.upstreams.map((u) => ({ id: u.id, baseUrl: u.baseUrl })),
      maxConcurrencyTotal: config.maxConcurrencyTotal,
      maxConcurrencyPerUpstream: config.maxConcurrencyPerUpstream,
    });
  });

  const shutdown = (sig) => {
    log.info('shutting down', { signal: sig });
    server.close(() => process.exit(0));
    // Force-exit if connections hang.
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Run only when invoked directly, not when imported by tests.
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    log.error('fatal', err);
    process.exit(1);
  });
}
