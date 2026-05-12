import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '../../src/storage/blobs.js';

const SHA256_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

let tmpRoot: string;
let store: BlobStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agent-os-blobs-'));
  store = createBlobStore({ root: join(tmpRoot, 'blobs') });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('createBlobStore', () => {
  it('write produces the expected sha256 for a known buffer', async () => {
    const hash = await store.write(Buffer.from('hello'));
    expect(hash).toBe(SHA256_HELLO);
  });

  it('write is idempotent — repeated writes yield the same hash', async () => {
    const a = await store.write(Buffer.from('hello'));
    const b = await store.write(Buffer.from('hello'));
    expect(a).toBe(b);
    expect(a).toBe(SHA256_HELLO);
  });

  it('write of a string and its UTF-8 buffer yield the same hash', async () => {
    const text = 'héllo, ☃';
    const fromString = await store.write(text);
    const fromBuffer = await store.write(Buffer.from(text, 'utf8'));
    expect(fromString).toBe(fromBuffer);
  });

  it('write of an empty buffer yields the empty sha256', async () => {
    const hash = await store.write(Buffer.alloc(0));
    expect(hash).toBe(SHA256_EMPTY);
  });

  it('read round-trips bytes exactly', async () => {
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xfd, 0xfe, 0xff]);
    const hash = await store.write(payload);
    const out = await store.read(hash);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(payload)).toBe(true);
  });

  it('read of a missing hash throws "blob not found: <hex>"', async () => {
    const missing = 'a'.repeat(64);
    await expect(store.read(missing)).rejects.toThrowError(
      new RegExp(`^blob not found: ${missing}$`),
    );
  });

  it('has returns true after write, false for an unwritten hash', async () => {
    const hash = await store.write('present');
    expect(await store.has(hash)).toBe(true);

    const unwritten = 'b'.repeat(64);
    expect(await store.has(unwritten)).toBe(false);
  });

  it('pathFor returns <root>/<2-char-subdir>/<62-char-filename>', () => {
    const hash = SHA256_HELLO;
    const p = store.pathFor(hash);
    expect(p.startsWith(store.root + sep)).toBe(true);

    const relative = p.slice(store.root.length + 1);
    const parts = relative.split(sep);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(2);
    expect(parts[1]).toHaveLength(62);
    expect(parts[0] + parts[1]).toBe(hash);
  });

  it('rejects invalid sha256 on pathFor, has, and read', async () => {
    const tooShort = 'abc';
    const tooLong = 'a'.repeat(65);
    const nonHex = 'g'.repeat(64);
    const upper = 'A'.repeat(64);

    for (const bad of [tooShort, tooLong, nonHex, upper]) {
      expect(() => store.pathFor(bad)).toThrowError(new RegExp(`^invalid sha256: `));
      await expect(store.has(bad)).rejects.toThrowError(new RegExp(`^invalid sha256: `));
      await expect(store.read(bad)).rejects.toThrowError(new RegExp(`^invalid sha256: `));
    }
  });
});
