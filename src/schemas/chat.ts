import { z } from 'zod';

/**
 * Chat message role schema
 */
export const chatMessageRoleSchema = z.enum(['system', 'user', 'assistant']);

/**
 * Chat message schema
 */
export const chatMessageSchema = z.object({
  role: chatMessageRoleSchema,
  content: z.string().min(1, 'Message content cannot be empty')
});

/**
 * Chat completion request schema
 */
export const chatCompletionRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(chatMessageSchema).min(1, 'At least one message is required'),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional().default(false)
});

/**
 * Extract type from schema
 */
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
