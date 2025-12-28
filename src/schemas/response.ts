import { z } from 'zod';

/**
 * Chat completion choice schema
 */
export const chatCompletionChoiceSchema = z.object({
  index: z.number().int().min(0),
  message: z.object({
    role: z.string(),
    content: z.string()
  }).optional(),
  delta: z.object({
    role: z.string().optional(),
    content: z.string().optional()
  }).optional(),
  finish_reason: z.string().nullable()
});

/**
 * Usage schema
 */
export const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative()
});

/**
 * Chat completion response schema
 */
export const chatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.enum(['chat.completion', 'chat.completion.chunk']),
  created: z.number().int().nonnegative(),
  model: z.string(),
  choices: z.array(chatCompletionChoiceSchema),
  usage: usageSchema.optional()
});

/**
 * Extract type from schema
 */
export type ChatCompletionResponse = z.infer<typeof chatCompletionResponseSchema>;
export type Usage = z.infer<typeof usageSchema>;
