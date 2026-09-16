/**
 * Intelligent model alias/upgrade mappings.
 * Maps deprecated or older model identifiers to their current equivalents,
 * preserving capability tier (opus/sonnet/haiku, flagship/mini, etc.).
 *
 * Applied before provider routing so the correct provider is targeted.
 * Current models pass through unchanged.
 *
 * Aliases are KV-configurable: store an array of
 * `{ "match": "<regex source>", "replacement": "<model id>", "note": "..." }`
 * under CORTEX_CONFIG key `config:model-aliases` to override the built-in
 * table without a deploy. Deleting the key restores the defaults below.
 * Upgrade semantics per alias are documented in docs/features/provider-routing.md.
 */

export interface ModelAlias {
  match: string;
  replacement: string;
  note?: string;
}

export const MODEL_ALIASES_CONFIG_KEY = 'config:model-aliases';

export const DEFAULT_MODEL_ALIASES: ModelAlias[] = [
  // === Anthropic Claude ===

  // Opus tier: claude-3-opus-* → claude-opus-4-6
  { match: '^claude-3-opus', replacement: 'claude-opus-4-6', note: 'Opus capability tier' },

  // Sonnet tier: claude-3-sonnet-*, claude-3-5-sonnet-*, claude-3-7-sonnet-* → claude-sonnet-4-6
  { match: '^claude-3.*-sonnet', replacement: 'claude-sonnet-4-6', note: 'Sonnet capability tier' },

  // Haiku tier: claude-3-haiku-*, claude-3-5-haiku-* → claude-haiku-4-5-20251001
  { match: '^claude-3.*-haiku', replacement: 'claude-haiku-4-5-20251001', note: 'Haiku capability tier' },

  // === OpenAI GPT ===

  // Budget tier: gpt-4o-mini → gpt-5-mini (must precede the gpt-4 rule)
  { match: '^gpt-4o-mini', replacement: 'gpt-5-mini', note: 'Budget capability tier' },

  // Budget tier: gpt-3.5-* → gpt-5-mini
  { match: '^gpt-3\\.5', replacement: 'gpt-5-mini', note: 'Budget capability tier' },

  // Flagship tier: gpt-4o, gpt-4-turbo, gpt-4 → gpt-5.2
  { match: '^gpt-4', replacement: 'gpt-5.2', note: 'Flagship capability tier' },

  // === Z.ai / GLM ===

  // GLM-4 flagship tier → glm-5.3
  { match: '^glm-4-plus', replacement: 'glm-5.3', note: 'GLM flagship tier' },
  { match: '^glm-4\\.6', replacement: 'glm-5.3', note: 'GLM flagship tier' },

  // GLM-4 budget tier → glm-5.3-flash
  { match: '^glm-4', replacement: 'glm-5.3-flash', note: 'GLM budget tier (cost-safe default)' }
];

export async function getModelAliases(env?: { CORTEX_CONFIG?: KVNamespace }): Promise<ModelAlias[]> {
  if (!env?.CORTEX_CONFIG || typeof env.CORTEX_CONFIG.get !== 'function') {
    return DEFAULT_MODEL_ALIASES;
  }

  let configured: unknown;
  try {
    configured = await env.CORTEX_CONFIG.get(MODEL_ALIASES_CONFIG_KEY, { type: 'json' });
  } catch {
    return DEFAULT_MODEL_ALIASES;
  }

  if (!Array.isArray(configured)) {
    return DEFAULT_MODEL_ALIASES;
  }

  const aliases: ModelAlias[] = [];
  for (const entry of configured) {
    const candidate = entry as { match?: unknown; replacement?: unknown; note?: unknown };
    if (typeof candidate?.match !== 'string' || typeof candidate?.replacement !== 'string') continue;
    if (candidate.match.length === 0 || candidate.replacement.length === 0) continue;
    if (!isValidRegex(candidate.match)) continue;

    aliases.push({
      match: candidate.match,
      replacement: candidate.replacement,
      note: typeof candidate.note === 'string' ? candidate.note : undefined
    });
  }

  return aliases.length > 0 ? aliases : DEFAULT_MODEL_ALIASES;
}

/**
 * Resolve a model name to its current canonical equivalent.
 * Returns the model unchanged if it is already current or unrecognised.
 */
export function resolveModelAlias(model: string, aliases: ModelAlias[] = DEFAULT_MODEL_ALIASES): string {
  for (const alias of aliases) {
    let pattern: RegExp;
    try {
      // nosemgrep: javascript.lang.security.audit.non-literal-regexp.non-literal-regexp
      // eslint-disable-next-line security/detect-non-literal-regexp
      pattern = new RegExp(alias.match, 'i');
    } catch {
      continue;
    }
    if (pattern.test(model)) {
      return alias.replacement;
    }
  }
  return model;
}

export async function resolveModelAliasFromEnv(
  model: string,
  env?: { CORTEX_CONFIG?: KVNamespace }
): Promise<string> {
  return resolveModelAlias(model, await getModelAliases(env));
}

function isValidRegex(source: string): boolean {
  try {
    // nosemgrep: javascript.lang.security.audit.non-literal-regexp.non-literal-regexp
    // eslint-disable-next-line security/detect-non-literal-regexp
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}
