import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Content-addressed blob store.
 *
 * Large payloads (e.g. tool inputs/outputs, prompt bodies, model responses)
 * are stored on disk under a hash address so the relational database can stay
 * compact and content is naturally diffable across runs. See PRD §2.4.
 */
export interface BlobStore {
  /**
   * Persist `data` and return its sha256 hex digest.
   *
   * Idempotent: writing the same bytes twice does not throw and returns the
   * same hash. Strings are encoded as UTF-8 before hashing.
   */
  write(data: Buffer | Uint8Array | string): Promise<string>;

  /**
   * Read the bytes previously written under `sha256`.
   *
   * @throws Error whose message starts with `blob not found: ` if the blob is
   *   absent on disk, or `invalid sha256: ` if the digest is malformed.
   */
  read(sha256: string): Promise<Buffer>;

  /**
   * Returns `true` if a blob with this digest exists on disk.
   *
   * @throws Error whose message starts with `invalid sha256: ` if the digest
   *   is malformed.
   */
  has(sha256: string): Promise<boolean>;

  /**
   * Resolve the on-disk path for a given digest. Pure: no FS access.
   *
   * @throws Error whose message starts with `invalid sha256: ` if the digest
   *   is malformed.
   */
  pathFor(sha256: string): string;

  /** Absolute path to the blob store root. */
  root: string;
}

export interface BlobStoreOptions {
  /**
   * Filesystem root for the store. Defaults to `<cwd>/blobs`. Created lazily
   * on first write.
   */
  root?: string;

  /**
   * Number of leading hex characters used as a subdirectory name. Defaults
   * to 2, yielding paths like `<root>/ab/cdef...`. Must be in `[1, 63]`.
   */
  fanout?: number;
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

function assertValidSha256(sha256: string): void {
  if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256)) {
    throw new Error(`invalid sha256: ${String(sha256)}`);
  }
}

function toBuffer(data: Buffer | Uint8Array | string): Buffer {
  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Create a content-addressed blob store rooted at `opts.root`.
 *
 * The root directory is created lazily on the first `write` — instantiating
 * the store has no filesystem side effects.
 */
export function createBlobStore(opts: BlobStoreOptions = {}): BlobStore {
  const fanout = opts.fanout ?? 2;
  if (!Number.isInteger(fanout) || fanout < 1 || fanout > 63) {
    throw new Error(`invalid fanout: ${String(fanout)} (must be an integer in [1, 63])`);
  }

  const root = resolve(opts.root ?? join(process.cwd(), 'blobs'));

  function pathFor(sha256: string): string {
    assertValidSha256(sha256);
    const prefix = sha256.slice(0, fanout);
    const rest = sha256.slice(fanout);
    return join(root, prefix, rest);
  }

  async function has(sha256: string): Promise<boolean> {
    const file = pathFor(sha256);
    try {
      const s = await stat(file);
      return s.isFile();
    } catch (err) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'ENOENT'
      ) {
        return false;
      }
      throw err;
    }
  }

  async function read(sha256: string): Promise<Buffer> {
    const file = pathFor(sha256);
    try {
      return await readFile(file);
    } catch (err) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'ENOENT'
      ) {
        throw new Error(`blob not found: ${sha256}`);
      }
      throw err;
    }
  }

  async function write(data: Buffer | Uint8Array | string): Promise<string> {
    const buf = toBuffer(data);
    const digest = hashBuffer(buf);
    const file = pathFor(digest);

    // Fast path: already on disk — write is idempotent.
    try {
      const s = await stat(file);
      if (s.isFile()) {
        return digest;
      }
    } catch (err) {
      if (
        err === null ||
        typeof err !== 'object' ||
        !('code' in err) ||
        (err as { code?: string }).code !== 'ENOENT'
      ) {
        throw err;
      }
    }

    await mkdir(dirname(file), { recursive: true });

    // `wx` would fail if a concurrent writer beat us; treat EEXIST as success
    // since the content is, by construction, identical.
    try {
      await writeFile(file, buf, { flag: 'wx' });
    } catch (err) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'EEXIST'
      ) {
        return digest;
      }
      throw err;
    }

    return digest;
  }

  return { root, pathFor, has, read, write };
}
