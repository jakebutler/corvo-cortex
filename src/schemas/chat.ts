import { z } from 'zod';

/**
 * Chat message role schema
 */
export const chatMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);

const chatMessageContentPartSchema = z.object({
  type: z.enum(['text', 'image_url']),
  text: z.string().optional(),
  image_url: z.object({
    url: z.string().min(1),
    detail: z.string().optional()
  }).optional()
});

/**
 * Chat message schema
 */
export const chatMessageSchema = z.object({
  role: chatMessageRoleSchema,
  content: z.union([
    z.string().min(1, 'Message content cannot be empty'),
    z.array(chatMessageContentPartSchema).min(1),
    z.null()
  ])
}).passthrough();

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
}).passthrough();

/**
 * Extract type from schema
 */
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
