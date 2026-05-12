import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit config.
 *
 * Note: we currently run migrations via a hand-rolled runner
 * (`src/storage/migrate.ts`) because the schema includes conditional virtual
 * tables (sqlite-vec) and CHECK constraints not easily expressed by
 * drizzle-kit. This config is here so `drizzle-kit` introspect/diff commands
 * still target the right schema and output directory if we ever switch.
 */
export default {
  out: './drizzle/migrations',
  schema: './src/storage/schema.ts',
  dialect: 'sqlite',
} satisfies Config;
