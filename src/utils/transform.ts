import type { LLMProvider } from '../types';
import { anthropicAdapter } from '../providers/anthropic';
import { openaiAdapter } from '../providers/openai';
import { zaiAdapter } from '../providers/zai';
import { openrouterAdapter } from '../providers/openrouter';

/**
 * Get the appropriate adapter for a provider
 */
export function getAdapterForProvider(provider: LLMProvider) {
  switch (provider) {
    case 'anthropic-direct':
      return anthropicAdapter;
    case 'openai-direct':
      return openaiAdapter;
    case 'z-ai-pro':
      return zaiAdapter;
    case 'openrouter':
      return openrouterAdapter;
    default:
      return openaiAdapter; // Default to OpenAI format
  }
}
