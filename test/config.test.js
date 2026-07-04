// Unit tests for config loading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('parses upstreams and aligns api keys', () => {
  process.env.UPSTREAMS = 'https://api.openai.com/v1, https://api.deepseek.com/v1\nhttps://generativelanguage.googleapis.com/v1beta/openai';
  process.env.UPSTREAM_API_KEYS = 'sk-a,-,sk-c';
  process.env.GATEWAY_API_KEY = 'secret';
  process.env.MAX_CONCURRENCY_PER_UPSTREAM = '64';
  delete process.env.GATEWAY_CONFIG;

  const c = loadConfig();
  assert.equal(c.upstreams.length, 3);
  assert.equal(c.upstreams[0].baseUrl, 'https://api.openai.com/v1');
  assert.equal(c.upstreams[0].apiKey, 'sk-a');
  assert.equal(c.upstreams[1].apiKey, ''); // "-" => no key
  assert.equal(c.upstreams[2].apiKey, 'sk-c');
  assert.equal(c.gatewayApiKey, 'secret');
  assert.equal(c.maxConcurrencyPerUpstream, 64);
});

test('strips trailing slashes from base urls', () => {
  process.env.UPSTREAMS = 'https://api.openai.com/v1///';
  process.env.UPSTREAM_API_KEYS = '';
  delete process.env.GATEWAY_CONFIG;
  const c = loadConfig();
  assert.equal(c.upstreams[0].baseUrl, 'https://api.openai.com/v1');
});

test('throws when no upstreams configured', () => {
  delete process.env.UPSTREAMS;
  delete process.env.UPSTREAM_API_KEYS;
  delete process.env.GATEWAY_CONFIG;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.OPENROUTER_URL;
  delete process.env.OPENROUTER_API_KEY;
  assert.throws(() => loadConfig(), /No upstreams configured/);
});

test('auto-detects Runloop gateway from OPENROUTER_BASE_URL', () => {
  delete process.env.UPSTREAMS;
  delete process.env.UPSTREAM_API_KEYS;
  delete process.env.GATEWAY_CONFIG;
  process.env.OPENROUTER_BASE_URL = 'https://gateway.runloop.ai';
  process.env.OPENROUTER_API_KEY = 'sk-test';
  const c = loadConfig();
  assert.equal(c.upstreams.length, 1);
  assert.equal(c.upstreams[0].baseUrl, 'https://gateway.runloop.ai/api/v1');
  assert.equal(c.upstreams[0].apiKey, 'sk-test');
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.OPENROUTER_API_KEY;
});

test('auto-detects generic OpenRouter with /v1', () => {
  delete process.env.UPSTREAMS;
  delete process.env.UPSTREAM_API_KEYS;
  delete process.env.GATEWAY_CONFIG;
  process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
  process.env.OPENROUTER_API_KEY = 'sk-or';
  const c = loadConfig();
  assert.equal(c.upstreams[0].baseUrl, 'https://openrouter.ai/api/v1');
});
