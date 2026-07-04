// Thinking-effort variant models.
//
// Generates virtual model variants that bake in a specific reasoning effort
// level, e.g. `anthropic/claude-opus-4.7-xhigh`. When a client requests such
// a variant, the gateway rewrites the model id to the base model and injects
// `verbosity: <effort>` plus `reasoning: {enabled: true, effort: <effort>}`
// before proxying upstream.
//
// Effort scale (per OpenRouter/Anthropic Claude 4.7 migration docs):
//   low → medium → high → xhigh → max
// `xhigh` is only honoured on Claude 4.7 Opus upstream; `max` on 4.6+.
// Unsupported levels fall back to `high` upstream, but we still expose them
// so the gateway presents a uniform variant surface for the configured bases.
//
// Variants are tagged with `upstream: 'gateway-variant'` in the model list
// so clients can distinguish them from real upstream models.

const DEFAULT_BASES = [
  'anthropic/claude-opus-4.7',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-fable-5',
];
const DEFAULT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** @returns {{bases:string[], efforts:string[], enabled:boolean}} */
export function loadVariantConfig() {
  const enabled = /^(1|true|yes|on)$/i.test(process.env.VARIANTS_ENABLED ?? 'true');
  const bases = (process.env.VARIANT_BASES || DEFAULT_BASES.join(','))
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const efforts = (process.env.VARIANT_EFFORTS || DEFAULT_EFFORTS.join(','))
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { bases, efforts, enabled };
}

/** @returns {string} */
export function variantId(base, effort) {
  return `${base}-${effort}`;
}

/**
 * Parse a variant model id into {base, effort}, or null if not a variant.
 * A variant matches one of the configured bases followed by `-<effort>`.
 * @param {string} model
 * @param {{bases:string[],efforts:string[]}} cfg
 * @returns {{base:string,effort:string}|null}
 */
export function parseVariant(model, cfg) {
  if (!model) return null;
  for (const base of cfg.bases) {
    if (model === base) return null;
    if (model.startsWith(base + '-')) {
      const effort = model.slice(base.length + 1);
      if (cfg.efforts.includes(effort)) return { base, effort };
    }
  }
  return null;
}

/**
 * Generate the list of virtual variant model entries for the model list.
 * @param {{bases:string[],efforts:string[],enabled:boolean}} cfg
 * @returns {Array<{id:string,object:string,owned_by:string,upstream:string,base_model:string,effort:string,created:number}>}
 */
export function generateVariantModels(cfg) {
  if (!cfg.enabled) return [];
  const out = [];
  for (const base of cfg.bases) {
    const provider = base.includes('/') ? base.split('/')[0] : 'anthropic';
    for (const effort of cfg.efforts) {
      out.push({
        id: variantId(base, effort),
        object: 'model',
        owned_by: provider,
        upstream: 'gateway-variant',
        base_model: base,
        effort,
        created: Math.floor(Date.now() / 1000),
      });
    }
  }
  return out;
}

/**
 * Rewrite a parsed request body for a variant model: swap the model id for
 * the base and inject the effort via `verbosity` and `reasoning`. Returns
 * the (possibly modified) body and whether a rewrite happened.
 *
 * @param {object} parsed
 * @param {{bases:string[],efforts:string[]}} cfg
 * @returns {{parsed:object, variant:{base:string,effort:string}|null}}
 */
export function applyVariant(parsed, cfg) {
  if (!parsed || !parsed.model) return { parsed, variant: null };
  const variant = parseVariant(parsed.model, cfg);
  if (!variant) return { parsed, variant: null };

  const next = { ...parsed };
  next.model = variant.base;
  // `verbosity` maps directly to Anthropic output_config.effort.
  next.verbosity = variant.effort;
  // Ensure reasoning is enabled at the chosen effort. Preserve any extra
  // client-supplied reasoning flags, but force enabled=true and effort.
  next.reasoning = {
    ...(parsed.reasoning && typeof parsed.reasoning === 'object' ? parsed.reasoning : {}),
    enabled: true,
    effort: variant.effort,
  };
  return { parsed: next, variant };
}
