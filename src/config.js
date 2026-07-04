// Loads and validates gateway configuration from the environment.
// Supports reading a JSON config file via GATEWAY_CONFIG for advanced setups.

import { readFileSync } from 'node:fs';

const DEFAULTS = {
  port: 8000,
  host: '0.0.0.0',
  gatewayApiKey: '',
  upstreams: [],
  upstreamApiKeys: [],
  upstreamRequestTimeoutMs: 120000,
  maxConcurrencyPerUpstream: 256,
  maxConcurrencyTotal: 1024,
  modelsCacheTtlMs: 30000,
  modelsPath: '/models',
  prettyJson: true,
  // Prompt caching (provider-side) support.
  promptCacheInject: 'anthropic', // 'off' | 'anthropic' | 'all'
  promptCacheTtl: '5m', // '5m' | '1h' (Anthropic cache_control ttl)
  promptCacheSticky: true,
  // Per-model provider pinning (OpenRouter provider object).
  // Default pins per project request:
  //   z-ai/glm-5.2             -> siliconflow/fp8   (explicit order)
  //   deepseek/deepseek-v4-pro -> "price"           (sort by price;
  //                                                       OpenRouter picks the
  //                                                       cheapest usable
  //                                                       provider, falling
  //                                                       back automatically)
  // A pin value of "price" injects {sort:"price"}; any other string is a
  // provider slug for {order:[...]} (pipe-separated => list).
  // Override or extend via MODEL_PROVIDERS env.
  modelProviders: {
    'z-ai/glm-5.2': 'siliconflow/fp8',
    'deepseek/deepseek-v4-pro': 'price',
  },
  modelProviderAllowFallback: false,
};

function splitList(value) {
  if (!value) return [];
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse a "model=slug" mapping (comma/newline-separated) or a JSON object.
 *  When `value` is empty, falls back to `defaults`. */
function parseModelProviders(value, defaults = {}) {
  if (!value) return { ...defaults };
  if (typeof value === 'object') return value;
  const out = {};
  for (const part of splitList(value)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const model = part.slice(0, eq).trim();
    const slug = part.slice(eq + 1).trim();
    if (!model || !slug) continue;
    // A model may map to multiple preferred providers: a/b|c/d
    const slugs = slug.split('|').map((s) => s.trim()).filter(Boolean);
    out[model] = slugs.length === 1 ? slugs[0] : slugs;
  }
  return out;
}

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function loadFileConfig() {
  const path = process.env.GATEWAY_CONFIG;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to read GATEWAY_CONFIG=${path}: ${err.message}`);
  }
}

/** @returns {ReturnType<typeof normalize>} */
export function loadConfig() {
  const file = loadFileConfig();

  const upstreams = splitList(process.env.UPSTREAMS ?? file.upstreams).map((url) =>
    url.replace(/\/+$/, '')
  );
  const upstreamApiKeys = splitList(process.env.UPSTREAM_API_KEYS ?? file.upstreamApiKeys);

  if (upstreams.length === 0) {
    // Auto-detect the Runloop/OpenRouter gateway from the environment so the
    // gateway works out-of-the-box without duplicating the API key into .env.
    // The Runloop gateway serves the OpenAI-compat API under /api/v1; generic
    // OpenRouter uses /v1.
    const base = process.env.OPENROUTER_BASE_URL || process.env.OPENROUTER_URL;
    if (base) {
      const u = new URL(base);
      const basePath = u.pathname.replace(/\/+$/, '');
      const suffix = /runloop\.ai/i.test(u.host) ? '/api/v1' : '/v1';
      upstreams.push(`${u.origin}${basePath}${suffix}`);
      upstreamApiKeys.push(process.env.OPENROUTER_API_KEY || '-');
    }
  }

  if (upstreams.length === 0) {
    throw new Error('No upstreams configured. Set UPSTREAMS (comma/newline-separated base URLs).');
  }

  return normalize({
    port: num(process.env.PORT ?? file.port, DEFAULTS.port),
    host: process.env.HOST ?? file.host ?? DEFAULTS.host,
    gatewayApiKey: process.env.GATEWAY_API_KEY ?? file.gatewayApiKey ?? DEFAULTS.gatewayApiKey,
    upstreams,
    upstreamApiKeys,
    upstreamRequestTimeoutMs: num(
      process.env.UPSTREAM_REQUEST_TIMEOUT_MS ?? file.upstreamRequestTimeoutMs,
      DEFAULTS.upstreamRequestTimeoutMs
    ),
    maxConcurrencyPerUpstream: num(
      process.env.MAX_CONCURRENCY_PER_UPSTREAM ?? file.maxConcurrencyPerUpstream,
      DEFAULTS.maxConcurrencyPerUpstream
    ),
    maxConcurrencyTotal: num(
      process.env.MAX_CONCURRENCY_TOTAL ?? file.maxConcurrencyTotal,
      DEFAULTS.maxConcurrencyTotal
    ),
    modelsCacheTtlMs: num(
      process.env.MODELS_CACHE_TTL_MS ?? file.modelsCacheTtlMs,
      DEFAULTS.modelsCacheTtlMs
    ),
    modelsPath: process.env.MODELS_PATH ?? file.modelsPath ?? DEFAULTS.modelsPath,
    prettyJson: bool(process.env.PRETTY_JSON ?? file.prettyJson, DEFAULTS.prettyJson),
    promptCacheInject: process.env.PROMPT_CACHE_INJECT ?? file.promptCacheInject ?? DEFAULTS.promptCacheInject,
    promptCacheTtl: process.env.PROMPT_CACHE_TTL ?? file.promptCacheTtl ?? DEFAULTS.promptCacheTtl,
    promptCacheSticky: bool(process.env.PROMPT_CACHE_STICKY ?? file.promptCacheSticky, DEFAULTS.promptCacheSticky),
    modelProviders: parseModelProviders(process.env.MODEL_PROVIDERS ?? file.modelProviders, DEFAULTS.modelProviders),
    modelProviderAllowFallback: bool(
      process.env.MODEL_PROVIDER_ALLOW_FALLBACK ?? file.modelProviderAllowFallback,
      DEFAULTS.modelProviderAllowFallback
    ),
  });
}

function normalize(c) {
  // Align keys array length to upstreams; "-" marks "no key".
  const keys = c.upstreams.map((_, i) => {
    const k = c.upstreamApiKeys[i];
    return k && k !== '-' ? k : '';
  });

  const upstreams = c.upstreams.map((baseUrl, i) => ({
    id: `upstream-${i + 1}`,
    baseUrl,
    apiKey: keys[i],
    // Round-robin cursor and per-upstream concurrency live on this object.
    cursor: 0,
  }));

  return {
    port: c.port,
    host: c.host,
    gatewayApiKey: c.gatewayApiKey,
    upstreams,
    upstreamRequestTimeoutMs: c.upstreamRequestTimeoutMs,
    maxConcurrencyPerUpstream: Math.max(0, c.maxConcurrencyPerUpstream),
    maxConcurrencyTotal: Math.max(0, c.maxConcurrencyTotal),
    modelsCacheTtlMs: Math.max(0, c.modelsCacheTtlMs),
    modelsPath: c.modelsPath.replace(/^\//, '/').replace(/^\/+/, '/'),
    prettyJson: !!c.prettyJson,
    promptCacheInject: ['off', 'anthropic', 'all'].includes(c.promptCacheInject) ? c.promptCacheInject : 'anthropic',
    promptCacheTtl: c.promptCacheTtl === '1h' ? '1h' : '5m',
    promptCacheSticky: !!c.promptCacheSticky,
    modelProviders: c.modelProviders && typeof c.modelProviders === 'object' ? c.modelProviders : {},
    modelProviderAllowFallback: !!c.modelProviderAllowFallback,
  };
}
