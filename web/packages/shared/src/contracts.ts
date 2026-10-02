import { z } from 'zod';

// Cursor position range in document
export const CursorRangeSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});

export type CursorRange = z.infer<typeof CursorRangeSchema>;

// Ask mode (tutoring guidance)
export const AskInSchema = z.object({
  docSlice: z.string(),
  instructions: z.string(),
  courseCtx: z.string().optional(),
});

export type AskIn = z.infer<typeof AskInSchema>;

export const AskOutSchema = z.object({
  assistant_text: z.string(),
});

export type AskOut = z.infer<typeof AskOutSchema>;

// Agent mode (edit operations)
export const EditInSchema = z.object({
  docSlice: z.string(),
  range: CursorRangeSchema,
  instructions: z.string(),
  courseCtx: z.string().optional(),
});

export type EditIn = z.infer<typeof EditInSchema>;

export const EditOpSchema = z.object({
  type: z.enum(['replace', 'insert', 'delete']),
  range: CursorRangeSchema,
  text: z.string(),
});

export type EditOp = z.infer<typeof EditOpSchema>;

// Inline Suggestions (Cursor-like experience)
export const SuggestionSchema = z.object({
  id: z.string().uuid(),
  type: z.literal('replace'),
  range: CursorRangeSchema,
  original: z.string(),
  replacement: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  severity: z.enum(['grammar', 'clarity', 'style', 'citation']).optional(),
});

export type Suggestion = z.infer<typeof SuggestionSchema>;

export const EditOutSchema = z.object({
  suggestions: z.array(SuggestionSchema),
  summary: z.string().optional(),
});

export type EditOut = z.infer<typeof EditOutSchema>;

