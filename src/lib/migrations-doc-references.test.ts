import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Migrations in this repo are applied manually with psql, following the
 * commands documented in README.md — there is no automatic runner and no
 * schema_migrations tracking table. That makes documentation the de facto
 * migration ledger: if a migration file is renamed (e.g. to fix a duplicate
 * numeric prefix), every stale reference in the docs points an operator at a
 * file that no longer exists, or worse, at a different migration.
 *
 * This guard fails whenever a doc references a migration filename that is not
 * present in migrations/, catching renames before they ship.
 */

const repoRoot = process.cwd();
const migrationsDir = join(repoRoot, 'migrations');

const DOC_FILES = ['README.md'];

function docMigrationRefs(content: string): string[] {
  return [...content.matchAll(/migrations\/(\d+_[A-Za-z0-9_-]+\.sql)/g)].map(
    (m) => m[1],
  );
}

describe('migration filename references', () => {
  const existing = new Set(
    readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')),
  );

  for (const doc of DOC_FILES) {
    it(`every migration referenced in ${doc} exists in migrations/`, () => {
      const refs = docMigrationRefs(readFileSync(join(repoRoot, doc), 'utf8'));
      expect(refs.length).toBeGreaterThan(0);
      const missing = [...new Set(refs)].filter((r) => !existing.has(r));
      expect(
        missing,
        `Stale migration references in ${doc} (file was renamed or removed):\n` +
          missing.map((m) => `  migrations/${m}`).join('\n'),
      ).toHaveLength(0);
    });
  }

  it('migration prefixes are contiguous starting at 001', () => {
    const prefixes = [...existing]
      .map((f) => f.match(/^(\d+)_/)?.[1])
      .filter((p): p is string => !!p)
      .map(Number)
      .sort((a, b) => a - b);
    const expected = prefixes.map((_, i) => i + 1);
    expect(prefixes, 'Gaps or duplicates in migration numbering').toEqual(
      expected,
    );
  });
});
