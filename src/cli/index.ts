#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';

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

  program
    .command('doctor')
    .description('Run a basic health check')
    .action(() => {
      process.stdout.write('agent-os: ok\n');
    });

  return program;
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  const invoked = resolve(process.argv[1]);
  return invoked === __filename;
}

if (isMainModule()) {
  buildProgram().parseAsync(process.argv).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`agent-os: ${message}\n`);
    process.exit(1);
  });
}
