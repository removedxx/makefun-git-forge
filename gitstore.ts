// gitstore.ts — the git object model for the forge: an in-memory object store, SHA-1 object ids,
// zlib packfiles (read: plain + ofs-delta + ref-delta; write: plain objects), pkt-line framing and
// the tree/commit helpers every surface (REST contents, smart HTTP, PR merge, MCP, GraphQL) shares.
//
// Objects are stored as the exact bytes they arrived with (a pack entry's inflated content, a loose
// object's content) so anything the suite pushes reads back byte for byte. Nothing here shells out:
// there is no git binary in the trial pod, and none is needed.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
// Git pack type codes: 1 commit, 2 tree, 3 blob, 4 tag, 6 ofs-delta, 7 ref-delta (deltas take their
// base's type, so their slots here are never read).
const TYPE_BY_CODE: readonly ObjType[] = ['blob', 'commit', 'tree', 'blob', 'tag', 'blob', 'blob', 'blob'];
const CODE_BY_TYPE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** The SHA-1 object id of a typed payload: sha1("<type> <size>\0" + data). */
export function oidOf(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

// --------------------------------------------------------------------------- object store

export class Store {
  readonly objects = new Map<string, GitObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store a payload under its computed id; returns the id. Idempotent. */
  put(type: ObjType, data: Buffer): string {
    const oid = oidOf(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (a pack entry): the bytes are trusted as received. */
  putKnown(oid: string, type: ObjType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }
}

// --------------------------------------------------------------------------- commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  message: string;
}

/** Parse a commit object's bytes. Tolerant of missing optional headers. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = ZERO_OID;
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(authorLine);
  return {
    tree,
    parents,
    authorLine,
    committerLine,
    authorName: match ? match[1]! : '',
    authorEmail: match ? match[2]! : '',
    authorTime: match ? Number(match[3]) : 0,
    message,
  };
}

/** Serialize a commit in git's canonical byte layout. */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string; // as written in the tree object: '100644', '100755', '120000', '40000', '160000'
  name: string;
  oid: string;
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Parse a tree object's binary entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: entries compare by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return isTreeMode(entry.mode) ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries in git's canonical order and byte layout. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every blob under a tree, keyed by repo-relative path. */
export function flattenTree(store: Store, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = store.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(store, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** The oid of the tree at a path prefix ('' is the root tree itself), or null. */
export function subtreeAt(store: Store, treeOid: string, parts: readonly string[]): string | null {
  let current: string | null = treeOid;
  for (const part of parts) {
    if (current === null) return null;
    const tree = store.get(current);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === part);
    if (!entry || !isTreeMode(entry.mode)) return null;
    current = entry.oid;
  }
  return current;
}

/**
 * Return a new tree oid with `parts` (a file path) set to `blobOid` (or removed when blobOid is
 * null), creating intermediate trees. `baseTreeOid` may be null for an empty tree.
 */
export function writeTreePath(store: Store, baseTreeOid: string | null, parts: readonly string[], blobOid: string | null, mode = '100644'): string {
  const entries: TreeEntry[] = baseTreeOid !== null && store.get(baseTreeOid)?.type === 'tree' ? parseTree(store.get(baseTreeOid)!.data) : [];
  const [head, ...rest] = parts as [string, ...string[]];
  const index = entries.findIndex((entry) => entry.name === head);
  if (rest.length === 0) {
    if (blobOid === null) {
      if (index >= 0) entries.splice(index, 1);
    } else if (index >= 0) {
      entries[index] = { mode, name: head, oid: blobOid };
    } else {
      entries.push({ mode, name: head, oid: blobOid });
    }
  } else {
    const childBase = index >= 0 && isTreeMode(entries[index]!.mode) ? entries[index]!.oid : null;
    const child = writeTreePath(store, childBase, rest, blobOid, mode);
    const childTree = store.get(child);
    const childEmpty = childTree !== undefined && parseTree(childTree.data).length === 0;
    if (childEmpty && blobOid === null) {
      if (index >= 0) entries.splice(index, 1);
    } else if (index >= 0) {
      entries[index] = { mode: '40000', name: head, oid: child };
    } else {
      entries.push({ mode: '40000', name: head, oid: child });
    }
  }
  return store.put('tree', buildTree(entries));
}

// --------------------------------------------------------------------------- graph walks

/** Every commit reachable from `roots` (inclusive), following parents. Missing objects stop a walk. */
export function commitClosure(store: Store, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` through commit parents (inclusive). */
export function isAncestor(store: Store, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** A best common ancestor of two commits (BFS from `a` by generation, first hit walking `b`), or null. */
export function mergeBase(store: Store, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfA = commitClosure(store, [a]);
  if (ancestorsOfA.has(b)) return b;
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/** Every object (commits, trees, blobs, tags) reachable from the given commit oids. */
export function objectClosure(store: Store, roots: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (target) stack.push(target[1]!);
    }
  }
  return out;
}

/** Commits from a tip, newest first: DFS pre-order following parents in order, duplicates removed. */
export function listCommits(store: Store, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') return;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) visit(parent);
  };
  visit(tip);
  return order;
}

// --------------------------------------------------------------------------- pkt-line framing

export const PKT_MAX = 65520;

/** One pkt-line payload (data lines carry their trailing '\n' when the protocol wants one). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > PKT_MAX) throw new Error(`pkt-line of ${length} bytes exceeds ${PKT_MAX}`);
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode every complete pkt-line in `buffer`; throws on a malformed length prefix. */
export function decodePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** A sideband packet: one band byte plus data, pkt-line framed, split under the size cap. */
export function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const capacity = PKT_MAX - 5; // 4 header bytes + 1 band byte
  for (let offset = 0; offset < data.length; offset += capacity) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + capacity));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([band])));
  return packets;
}

// --------------------------------------------------------------------------- packfiles

/** Apply a git delta (`base` payload -> result payload). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint overruns the buffer');
      const byte = delta[offset]!;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta source size ${sourceSize} != base size ${base.length}`);
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset]! * 2 ** (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize += delta[offset]! * 2 ** (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(parts);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta produced the wrong size');
  return result;
}

/**
 * Inflate one deflate stream starting at `offset`, reporting how many compressed bytes it used.
 * Node's zlib reports `engine.bytesRead` when asked for info; that is the consumed count.
 */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  const rest = buffer.subarray(offset);
  const result = inflateSync(rest, { info: true }) as unknown as { buffer: Buffer; engine: { bytesRead: number } };
  if (result && result.buffer && typeof result.engine?.bytesRead === 'number' && result.engine.bytesRead > 0) {
    return { data: result.buffer, consumed: result.engine.bytesRead };
  }
  // Fallback: binary-search the shortest prefix that inflates (kept for runtimes without info).
  let low = 1;
  let high = rest.length;
  let best: Buffer | null = null;
  let bestLength = rest.length;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      best = inflateSync(rest.subarray(0, mid));
      bestLength = mid;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (best === null) throw new Error('corrupt deflate stream in pack');
  return { data: best, consumed: bestLength };
}

export interface PackReadResult {
  objects: Array<{ oid: string; type: ObjType; data: Buffer }>;
  count: number;
}

/**
 * Read a packfile into `store` (when given) and return its objects. Deltas resolve against the pack
 * itself first, then the store (a thin pack's bases). Throws on any structural problem.
 */
export function readPack(pack: Buffer, store?: Store): PackReadResult {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  interface Pending { type: ObjType; data: Buffer; baseOid?: string; baseOffset?: number }
  const pending: Pending[] = [];
  const byOffset = new Map<number, number>(); // pack offset -> pending index (resolved or not)
  const resolved = new Map<number, { oid: string; type: ObjType; data: Buffer }>();
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset]!;
    offset += 1;
    let typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint back to the base's start.
      let backByte = pack[offset]!;
      offset += 1;
      let back = backByte & 0x7f;
      while (backByte & 0x80) {
        backByte = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (backByte & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeCode === 7) {
      // REF_DELTA: the base's 20-byte id follows.
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, consumed } = inflateAt(pack, offset);
    offset += consumed;
    if (data.length !== size) throw new Error(`pack object size mismatch: header ${size}, inflated ${data.length}`);
    const type = TYPE_BY_CODE[typeCode]!;
    pending.push({ type, data, baseOid, baseOffset });
    byOffset.set(start, index);
  }
  // Resolve in dependency order; deltas may chain, and a ref-delta base may be any pack object
  // (plain or itself a resolved delta) or an object the store already holds (a thin pack).
  const indexByOid = new Map<string, number>();
  pending.forEach((entry, index) => {
    if (entry.baseOid === undefined && entry.baseOffset === undefined) indexByOid.set(oidOf(entry.type, entry.data), index);
  });
  const resolve = (index: number): { oid: string; type: ObjType; data: Buffer } => {
    const cached = resolved.get(index);
    if (cached) return cached;
    const entry = pending[index]!;
    let out: { oid: string; type: ObjType; data: Buffer };
    if (entry.baseOid === undefined && entry.baseOffset === undefined) {
      out = { oid: oidOf(entry.type, entry.data), type: entry.type, data: entry.data };
    } else {
      let base: { type: ObjType; data: Buffer } | undefined;
      if (entry.baseOffset !== undefined) {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex === undefined) throw new Error('ofs-delta base offset is not in the pack');
        base = resolve(baseIndex);
      } else {
        const baseIndex = indexByOid.get(entry.baseOid!);
        if (baseIndex !== undefined && baseIndex !== index) base = resolve(baseIndex);
        else if (store && store.has(entry.baseOid!)) base = store.get(entry.baseOid!);
        else throw new Error(`ref-delta base ${entry.baseOid} is not available`);
      }
      if (!base) throw new Error('delta base is not available');
      const data = applyDelta(base.data, entry.data);
      out = { oid: oidOf(base.type, data), type: base.type, data };
    }
    resolved.set(index, out);
    indexByOid.set(out.oid, index);
    return out;
  };
  const objects: PackReadResult['objects'] = [];
  for (let index = 0; index < count; index += 1) {
    const object = resolve(index);
    objects.push(object);
    if (store) store.putKnown(object.oid, object.type, object.data);
  }
  return { objects, count };
}

/** Write a packfile of plain (undeltified) objects in the given order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.data.length;
    const first = (CODE_BY_TYPE[object.type] << 4) | (size & 0x0f);
    size = Math.floor(size / 16);
    const headerBytes: number[] = [];
    if (size > 0) {
      headerBytes.push(first | 0x80);
      while (size > 0) {
        const byte = size & 0x7f;
        size = Math.floor(size / 128);
        headerBytes.push(size > 0 ? byte | 0x80 : byte);
      }
    } else {
      headerBytes.push(first);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
