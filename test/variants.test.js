// Tests for thinking-effort variant models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadVariantConfig,
  variantId,
  parseVariant,
  generateVariantModels,
  applyVariant,
} from '../src/variants.js';

const cfg = () => {
  const c = loadVariantConfig();
  return { bases: c.bases, efforts: c.efforts };
};

test('default bases include the three requested models', () => {
  delete process.env.VARIANT_BASES;
  const c = loadVariantConfig();
  assert.ok(c.bases.includes('anthropic/claude-opus-4.7'));
  assert.ok(c.bases.includes('anthropic/claude-opus-4.8'));
  assert.ok(c.bases.includes('anthropic/claude-fable-5'));
  assert.deepEqual(c.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(c.enabled, true);
});

test('parseVariant recognises variant ids and rejects non-variants', () => {
  const c = cfg();
  assert.deepEqual(parseVariant('anthropic/claude-opus-4.7-xhigh', c), { base: 'anthropic/claude-opus-4.7', effort: 'xhigh' });
  assert.deepEqual(parseVariant('anthropic/claude-fable-5-low', c), { base: 'anthropic/claude-fable-5', effort: 'low' });
  assert.equal(parseVariant('anthropic/claude-opus-4.7', c), null);
  assert.equal(parseVariant('openai/gpt-4o-mini', c), null);
  assert.equal(parseVariant('anthropic/claude-opus-4.7-fast', c), null); // -fast is not an effort
  assert.equal(parseVariant('anthropic/claude-opus-4.7-bogus', c), null);
});

test('generateVariantModels produces one entry per base x effort', () => {
  const c = { bases: ['anthropic/claude-opus-4.7'], efforts: ['low', 'xhigh'], enabled: true };
  const v = generateVariantModels(c);
  assert.equal(v.length, 2);
  assert.equal(v[0].id, 'anthropic/claude-opus-4.7-low');
  assert.equal(v[0].base_model, 'anthropic/claude-opus-4.7');
  assert.equal(v[0].effort, 'low');
  assert.equal(v[0].upstream, 'gateway-variant');
  assert.equal(v[0].object, 'model');
});

test('disabled config produces no variants', () => {
  assert.deepEqual(generateVariantModels({ bases: ['x'], efforts: ['low'], enabled: false }), []);
});

test('applyVariant rewrites model and injects verbosity + reasoning', () => {
  const c = cfg();
  const { parsed, variant } = applyVariant({ model: 'anthropic/claude-opus-4.7-xhigh', messages: [] }, c);
  assert.deepEqual(variant, { base: 'anthropic/claude-opus-4.7', effort: 'xhigh' });
  assert.equal(parsed.model, 'anthropic/claude-opus-4.7');
  assert.equal(parsed.verbosity, 'xhigh');
  assert.equal(parsed.reasoning.enabled, true);
  assert.equal(parsed.reasoning.effort, 'xhigh');
});

test('applyVariant preserves other fields and client reasoning extras', () => {
  const c = cfg();
  const input = {
    model: 'anthropic/claude-fable-5-max',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: { exclude: true },
  };
  const { parsed, variant } = applyVariant(input, c);
  assert.equal(variant.effort, 'max');
  assert.equal(parsed.model, 'anthropic/claude-fable-5');
  assert.equal(parsed.max_tokens, 100);
  assert.equal(parsed.reasoning.exclude, true); // preserved
  assert.equal(parsed.reasoning.enabled, true); // forced
  assert.equal(parsed.reasoning.effort, 'max'); // forced
});

test('applyVariant is a no-op for non-variant models', () => {
  const c = cfg();
  const input = { model: 'anthropic/claude-opus-4.7', messages: [] };
  const { parsed, variant } = applyVariant(input, c);
  assert.equal(variant, null);
  assert.equal(parsed, input);
  assert.equal(parsed.verbosity, undefined);
});
