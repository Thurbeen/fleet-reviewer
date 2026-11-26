import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manifest } from '../src/manifest.ts';
import { PLUGIN } from '../src/util.ts';

const listing = readFileSync(new URL('../fleet-plugin.toml', import.meta.url), 'utf8');

function stringField(key: string): string | undefined {
  return listing.match(new RegExp(`^${key} = "([^"]*)"$`, 'm'))?.[1];
}

function stringList(key: string): string[] {
  const list = listing.match(new RegExp(`^${key} = \\[([^\\]]*)\\]$`, 'm'))?.[1] ?? '';
  return [...list.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

describe('fleet-plugin.toml, the Fleet plugins gallery listing', () => {
  it('names the plugin the manifest names', () => {
    expect(stringField('name')).toBe(PLUGIN);
  });

  it('lists exactly the kinds the manifest declares', () => {
    expect(stringList('kinds')).toEqual(manifest().kinds.map((kind) => kind.kind));
  });
});
