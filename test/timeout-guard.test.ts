// Timeout guard: every test must declare an explicit timeout instead of
// relying on the default 5s budget, which flakes under suite contention.
// Fails on any bare it(...) or test(...) or any unbounded child-process exec in test/.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

describe('timeout guard', () => {
  it('every test declares an explicit timeout and every child exec is bounded', { timeout: 30_000 }, () => {
    const bad: string[] = [];
    for (const f of readdirSync(here).filter((x) => x.endsWith('.test.ts'))) {
      const lines = readFileSync(join(here, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(?:it|test)(?:\.\w+)?\(/.test(line) && !/\{\s*timeout:/.test(line)) {
          bad.push(`${f}:${i + 1}: bare test without { timeout: ... }: ${line.trim()}`);
        }
        if (line.includes('execFileSync(') && !line.includes('timeout:')) {
          bad.push(`${f}:${i + 1}: unbounded execFileSync without timeout: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(bad, [], `missing explicit timeouts:\n${bad.join('\n')}`);
  });
});
