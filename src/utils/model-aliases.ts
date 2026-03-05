/**
 * Intelligent model alias/upgrade mappings.
 * Maps deprecated or older model identifiers to their current equivalents,
 * preserving capability tier (opus/sonnet/haiku, flagship/mini, etc.).
 *
 * Applied before provider routing so the correct provider is targeted.
 * Current models pass through unchanged.
 */

const MODEL_ALIASES: Array<{ pattern: RegExp; replacement: string }> = [
  // === Anthropic Claude ===

  // Opus tier: claude-3-opus-* → claude-opus-4-6
  { pattern: /^claude-3-opus/i, replacement: 'claude-opus-4-6' },

  // Sonnet tier: claude-3-sonnet-*, claude-3-5-sonnet-*, claude-3-7-sonnet-* → claude-sonnet-4-6
  { pattern: /^claude-3.*-sonnet/i, replacement: 'claude-sonnet-4-6' },

  // Haiku tier: claude-3-haiku-*, claude-3-5-haiku-* → claude-haiku-4-5-20251001
  { pattern: /^claude-3.*-haiku/i, replacement: 'claude-haiku-4-5-20251001' },

  // === OpenAI GPT ===

  // Budget tier: gpt-4o-mini → gpt-5-mini (must precede gpt-4 pattern)
  { pattern: /^gpt-4o-mini/i, replacement: 'gpt-5-mini' },

  // Budget tier: gpt-3.5-* → gpt-5-mini
  { pattern: /^gpt-3\.5/i, replacement: 'gpt-5-mini' },

  // Flagship tier: gpt-4o, gpt-4-turbo, gpt-4 → gpt-5-2
  { pattern: /^gpt-4/i, replacement: 'gpt-5-2' },

  // === Z.ai / GLM ===

  // GLM-4.x series → glm-5
  { pattern: /^glm-4/i, replacement: 'glm-5' },
];

/**
 * Resolve a model name to its current canonical equivalent.
 * Returns the model unchanged if it is already current or unrecognised.
 */
export function resolveModelAlias(model: string): string {
  for (const { pattern, replacement } of MODEL_ALIASES) {
    if (pattern.test(model)) {
      return replacement;
    }
  }
  return model;
}
