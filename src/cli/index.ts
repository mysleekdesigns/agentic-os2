#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { buildInitCommand } from './commands/init.js';
import { buildAgentCommand } from './commands/agent.js';
import { buildApprovalsCommand } from './commands/approvals.js';
import { buildMemoryCommand } from './commands/memory.js';
import { buildRunCommand } from './commands/run.js';
import { buildWorkflowCommand } from './commands/workflow.js';
import { buildShowCommand } from './commands/show.js';
import { buildLogsCommand } from './commands/logs.js';
import { buildEvalCommand } from './commands/eval.js';
import { buildToolsCommand } from './commands/tools.js';
import { buildProviderCommand } from './commands/provider.js';
import { buildDoctorCommand } from './commands/doctor.js';
import { buildVersionCommand } from './commands/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PackageJson {
  version: string;
  name?: string;
}

function loadPackageJson(): PackageJson {
  // From `dist/cli/index.js` or `src/cli/index.ts`, package.json is two levels up.
  const pkgPath = resolve(__dirname, '..', '..', 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  return JSON.parse(raw) as PackageJson;
}

export const VERSION: string = loadPackageJson().version;

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('agent-os')
    .description('Agent OS — local-first developer operating layer for AI agents')
    .version(VERSION, '-v, --version', 'output the current version');

  program.addCommand(buildDoctorCommand());
  program.addCommand(buildVersionCommand());
  program.addCommand(buildInitCommand());
  program.addCommand(buildAgentCommand());
  program.addCommand(buildRunCommand());
  program.addCommand(buildWorkflowCommand());
  program.addCommand(buildApprovalsCommand());
  program.addCommand(buildMemoryCommand());
  program.addCommand(buildShowCommand());
  program.addCommand(buildLogsCommand());
  program.addCommand(buildEvalCommand());
  program.addCommand(buildToolsCommand());
  program.addCommand(buildProviderCommand());

  return program;
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const invoked = resolve(process.argv[1]);
  return invoked === __filename;
}

if (isMainModule()) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agent-os: ${message}\n`);
      process.exit(1);
    });
}
