import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runSpecConsistencyTool } from './spec-consistency.js';

/**
 * `@hira/mcp-skills` — Hira's built-in MCP server (SPEC §4.6). It hosts
 * model-callable skills; the runtime mounts it into an agent's session
 * via `--mcp-config`.
 *
 * The project root is passed in `HIRA_PROJECT_ROOT` so skills that read
 * the memory store know where to look.
 */

const projectRoot = process.env.HIRA_PROJECT_ROOT ?? process.cwd();

const server = new McpServer({ name: 'hira-skills', version: '0.0.1' });

server.registerTool(
  'spec_consistency_check',
  {
    description:
      'Cross-Artifact Consistency check (SPEC §4.8). Given a proposed task ' +
      'graph (and optionally an ADR), reports structural blockers (no tasks, ' +
      'empty descriptions, unknown owners, dangling dependencies, cycles) and ' +
      'warnings (a new ADR overlapping a prior baseline decision). Use it to ' +
      'self-check a plan before handing it off.',
    inputSchema: {
      tasks: z
        .array(
          z.object({
            id: z.string(),
            description: z.string(),
            owner: z.string(),
            depends_on: z.array(z.string()),
          }),
        )
        .describe('The proposed task graph.'),
      adr: z
        .object({
          title: z.string().optional(),
          tags: z.array(z.string()).optional(),
        })
        .nullable()
        .optional()
        .describe('The Architect ADR for this Run, if one exists.'),
      known_owners: z
        .array(z.string())
        .optional()
        .describe('Override the known-owner roster (defaults to the Hira built-ins).'),
    },
  },
  async (args) => {
    const report = await runSpecConsistencyTool(args, projectRoot);
    return {
      content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
      isError: report.status === 'blocked',
    };
  },
);

await server.connect(new StdioServerTransport());
