import { readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('migrations directory', () => {
  it('has no two files sharing the same numeric prefix', () => {
    const migrationsDir = join(process.cwd(), 'migrations');
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const prefixCounts = new Map<string, string[]>();
    for (const file of files) {
      const match = file.match(/^(\d+)_/);
      if (!match) continue;
      const prefix = match[1];
      const existing = prefixCounts.get(prefix) ?? [];
      prefixCounts.set(prefix, [...existing, file]);
    }

    const duplicates = [...prefixCounts.entries()].filter(
      ([, names]) => names.length > 1,
    );

    expect(
      duplicates,
      `Duplicate numeric prefixes found:\n${duplicates
        .map(([prefix, names]) => `  ${prefix}: ${names.join(', ')}`)
        .join('\n')}`,
    ).toHaveLength(0);
  });
});
