/**
 * Zod schema for an Agent OS agent definition's YAML frontmatter.
 *
 * Canonical reference: PRD §2.6 (agent definition shape). Loader code lives
 * next door in `loader.ts`; this module is the source of truth for the
 * accepted shape and is intentionally free of filesystem concerns.
 *
 * Notes:
 * - `provider` is a free-form string. Provider IDs are owned by Phase 3 — we
 *   deliberately avoid locking the union here so adding a provider does not
 *   require a schema edit.
 * - `tools.allowed`, `tools.approval_required`, `memory.read`, `memory.write`
 *   default to empty arrays so agents can omit the keys when unused.
 * - `model`, `eval` are optional; everything else is required.
 */

import { z } from 'zod';

/** Permission outcomes for the capability gates (PRD §2.6). */
export const PermissionValueSchema = z.enum(['allow', 'approval_required', 'deny']);
export type PermissionValue = z.infer<typeof PermissionValueSchema>;

const ToolsSchema = z
  .object({
    allowed: z.array(z.string()).default([]),
    approval_required: z.array(z.string()).default([]),
  })
  .default({ allowed: [], approval_required: [] });

const PermissionsSchema = z.object({
  network: PermissionValueSchema,
  file_read: PermissionValueSchema,
  file_write: PermissionValueSchema,
  shell: PermissionValueSchema,
});

const MemorySchema = z
  .object({
    read: z.array(z.string()).default([]),
    write: z.array(z.string()).default([]),
  })
  .default({ read: [], write: [] });

const EvalSchema = z.object({
  // Glob (or list of globs) pointing at fixture files; loader does not expand.
  fixtures: z.union([z.string(), z.array(z.string())]).optional(),
  success_criteria: z.array(z.string()).default([]),
});

// Slug constraint: prevents path traversal in the mirror writer (which derives
// `<claudeAgentsDir>/<id>.md` from this field) and keeps registry keys stable.
const AgentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, {
  message: 'id must be 1-64 chars of [a-z0-9_-], starting with [a-z0-9]',
});

export const AgentFrontmatterSchema = z.object({
  id: AgentIdSchema,
  name: z.string().min(1),
  // Stored on disk as YAML integer; serialised back to string when written to
  // the agents table (text column per PRD §2.4).
  version: z.number().int().positive(),
  role: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  tools: ToolsSchema,
  permissions: PermissionsSchema,
  memory: MemorySchema,
  eval: EvalSchema.optional(),
});

export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;
