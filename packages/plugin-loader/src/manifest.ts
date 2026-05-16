import { z } from 'zod';

export const AgentManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  kind: z.literal('agent'),
  model: z.string().optional(),
  prompt: z.string().default('./system.md'),
  skills: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  inputs: z.object({ schema: z.string() }).optional(),
  outputs: z.object({ schema: z.string() }).optional(),
  escalates_to: z.array(z.string()).default([]),
  budgets: z
    .object({
      max_turns: z.number().int().positive().default(40),
      max_tokens: z.number().int().positive().default(200_000),
    })
    .default({ max_turns: 40, max_tokens: 200_000 }),
  session: z
    .object({
      mode: z.enum(['fresh', 'warm']).default('fresh'),
    })
    .default({ mode: 'fresh' }),
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export const SkillManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  kind: z.literal('skill'),
  entrypoint: z.string().optional(),
  inputs: z.object({ schema: z.string() }).optional(),
  outputs: z.object({ schema: z.string() }).optional(),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
