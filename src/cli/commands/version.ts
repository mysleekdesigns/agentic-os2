/**
 * `agent-os version` — non-flag alias for `--version`.
 *
 * Commander wires `-v/--version` automatically; this subcommand exists so that
 * subagents and humans who reach for `agent-os version` (the more common UX
 * across modern CLIs) also get a useful answer, plus `--json` for tooling.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PackageJson {
  name?: string;
  version: string;
}

function loadPackageJson(): PackageJson {
  const pkgPath = resolve(__dirname, '..', '..', '..', 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  return JSON.parse(raw) as PackageJson;
}

interface VersionCliOptions {
  json?: boolean;
}

export function buildVersionCommand(): Command {
  const cmd = new Command('version');
  cmd
    .description('Print the agent-os version (mirrors -v/--version)')
    .option('--json', 'Emit { name, version, node } as JSON', false)
    .action((options: VersionCliOptions) => {
      const pkg = loadPackageJson();
      if (options.json) {
        const payload = {
          name: pkg.name ?? 'agent-os',
          version: pkg.version,
          node: process.versions.node,
        };
        process.stdout.write(JSON.stringify(payload) + '\n');
      } else {
        process.stdout.write(`${pkg.version}\n`);
      }
    });
  return cmd;
}
