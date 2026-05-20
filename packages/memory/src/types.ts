import { z } from 'zod';

/**
 * Kinds of things worth remembering across Runs (SPEC §5.8 + §12 #11).
 *
 * - `adr`        — Architecture Decision Records from the Solution Architect.
 *                  Always remembered when produced.
 * - `outcome`    — Notable task outcome: "we tried X, here's what happened".
 *                  Memory Maintainer decides — quality over quantity.
 * - `convention` — Project-wide rule the team adopted (e.g. naming, layout,
 *                  preferred libraries). Manual for now (M2.b will add a
 *                  `hira memory write` command); included here so the schema
 *                  is stable.
 * - `glossary`   — Term → meaning binding tied to a code location. Manual for
 *                  now, same as conventions.
 */
export const MemoryKindSchema = z.enum(['adr', 'outcome', 'convention', 'glossary']);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemorySourceSchema = z.object({
  run_id: z.string().min(1),
  handoff_id: z.string().optional(),
});
export type MemorySource = z.infer<typeof MemorySourceSchema>;

/** New record proposed by the Memory Maintainer (or `hira memory write` in M2.b). */
export const NewMemoryRecordSchema = z.object({
  kind: MemoryKindSchema,
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  ttl_days: z.number().int().positive().optional(),
  source: MemorySourceSchema.optional(),
});
export type NewMemoryRecord = z.infer<typeof NewMemoryRecordSchema>;

/** A persisted record. */
export const MemoryRecordSchema = NewMemoryRecordSchema.extend({
  id: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
