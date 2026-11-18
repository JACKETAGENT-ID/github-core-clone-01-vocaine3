// Git smart-HTTP protocol: pkt-lines, pack files (plain + delta), upload-pack v2/v0,
// receive-pack v0. Node 24 stdlib only (node:zlib, node:crypto).
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObj, ObjType, Repo } from './store.ts';
import { collectCommits, hashObject, isAncestor, parseCommit, parseTree, storeObject } from './store.ts';

export const AGENT = 'forge-v3/1.0.0';

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

/** Parse pkt-lines until flush or end. Returns lines (without headers) and the byte offset after the flush. */
export function parsePktLines(buf: Buffer, start = 0): { lines: Buffer[]; next: number } {
  const lines: Buffer[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) return { lines, next: i + 4 };
    if (len === 1) {
      i += 4;
      continue;
    }
    lines.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return { lines, next: i };
}

function lineText(b: Buffer): string {
  return b.toString('utf8').replace(/\n$/, '');
}

// ---------------------------------------------------------------------------
// Pack files
// ---------------------------------------------------------------------------

function encodeVarintHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let s = size;
  let first = (type << 4) | (s & 0x0f);
  s >>>= 4;
  if (s > 0) first |= 0x80;
  bytes.push(first);
  while (s > 0) {
    let b = s & 0x7f;
    s >>>= 7;
    if (s > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a plain (no-delta) pack for the given oids, in deterministic sorted order. */
export function writePack(repo: Repo, oids: string[]): Buffer {
  const sorted = [...oids].sort();
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  parts.push(head);
  for (const oid of sorted) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    parts.push(encodeVarintHeader(TYPE_CODE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Wrap pack bytes into sideband band-1 pkt-lines (chunked), then a flush. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const chunk = pack.subarray(i, Math.min(i + CHUNK, pack.length));
    const inner = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(inner));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// --- delta application -----------------------------------------------------

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = off;
  while (i < buf.length) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readVarint(delta, 0);
  const tgt = readVarint(delta, src.next);
  if (src.value !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let i = tgt.next;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let b = 0; b < 4; b++) if (op & (1 << b)) offset |= delta[i++] << (8 * b);
      for (let b = 0; b < 3; b++) if (op & (0x10 << b)) size |= delta[i++] << (8 * b);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== tgt.value) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Parse a pack, storing every object into the repo. Returns the oids in pack order.
 * Handles plain objects plus OFS_DELTA / REF_DELTA defensively (the client only
 * ever sends plain packs, but a delta must not break the server).
 */
export function readPack(repo: Repo, buf: Buffer): string[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const count = buf.readUInt32BE(8);
  const oids: string[] = [];
  // Object start offsets -> resolved object (for OFS_DELTA bases).
  const byOffset = new Map<number, { oid: string; type: ObjType; data: Buffer }>();
  let i = 12;
  for (let n = 0; n < count; n++) {
    const start = i;
    // varint header: type in bits 4-6, size in bits 0-3 + continuation bytes.
    let b = buf[i++];
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[i++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let type: ObjType;
    let data: Buffer;
    if (typeCode === 6 || typeCode === 7) {
      let base: { type: ObjType; data: Buffer } | undefined;
      if (typeCode === 6) {
        // OFS_DELTA: negative-offset varint.
        let off = buf[i++];
        let neg = off & 0x7f;
        while (off & 0x80) {
          off = buf[i++];
          neg = ((neg + 1) << 7) | (off & 0x7f);
        }
        base = byOffset.get(start - neg);
      } else {
        // REF_DELTA: 20-byte base oid.
        const baseOid = buf.subarray(i, i + 20).toString('hex');
        i += 20;
        base = repo.objects.get(baseOid);
        if (!base) {
          for (const v of byOffset.values()) if (v.oid === baseOid) { base = v; break; }
        }
      }
      if (!base) throw new Error('delta base not found');
      const inflated = inflateWithLength(buf, i);
      i += inflated.length;
      data = applyDelta(base.data, inflated.data);
      type = base.type;
      if (data.length !== size) throw new Error('delta target size mismatch');
    } else {
      type = typeCode === 1 ? 'commit' : typeCode === 2 ? 'tree' : typeCode === 3 ? 'blob' : 'tag';
      const inflated = inflateWithLength(buf, i);
      i += inflated.length;
      data = inflated.data;
      if (data.length !== size) throw new Error('object size mismatch');
    }
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    byOffset.set(start, { oid, type, data });
    oids.push(oid);
  }
  return oids;
}

/**
 * Inflate the deflate stream starting at `off` and report how many input bytes
 * it consumed. `inflateSync(..., { info: true })` returns the engine, whose
 * `bytesWritten` is exactly the stream length (trailing bytes are ignored, so
 * the next object starts at off + length). One inflate per object.
 */
function inflateWithLength(buf: Buffer, off: number): { data: Buffer; length: number } {
  const r = inflateSync(buf.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: r.buffer, length: r.engine.bytesWritten };
}

// ---------------------------------------------------------------------------
// Fetch computation (v2 fetch / v0 fetch share this)
// ---------------------------------------------------------------------------

export interface FetchPlan {
  toSend: string[];
  shallowOut: string[];
  unshallowOut: string[];
  ackOids: string[];
  nak: boolean;
}

/**
 * Objects a fetch must send for the wanted commits: each wanted commit plus its
 * full tree closure — but NOT the parents of wanted commits. (Depth limits which
 * commits are wanted; following parents here would leak history past the depth.)
 */
function collectWantOids(objects: Map<string, GitObj>, wantCommits: string[]): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const stack = [...wantCommits];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const treeStack = [parseCommit(obj.data).tree];
      while (treeStack.length > 0) {
        const t = treeStack.pop()!;
        if (out.has(t)) continue;
        const tobj = objects.get(t);
        if (!tobj || tobj.type !== 'tree') continue;
        out.add(t);
        for (const e of parseTree(tobj.data)) {
          if (e.isDir) treeStack.push(e.oid);
          else out.add(e.oid);
        }
      }
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})\n/);
      if (m) stack.push(m[1]);
    }
  }
  return out;
}

/** Closure of haves, stopping descent at the client's shallow commits. */
function collectHeld(objects: Map<string, GitObj>, haves: string[], shallow: Set<string>): Set<string> {
  const held = new Set<string>();
  const stack: Array<{ oid: string; stop: boolean }> = haves.map((oid) => ({ oid, stop: false }));
  while (stack.length > 0) {
    const { oid, stop } = stack.pop()!;
    if (held.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    held.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push({ oid: c.tree, stop: false });
      if (!stop && !shallow.has(oid)) {
        for (const p of c.parents) stack.push({ oid: p, stop: false });
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push({ oid: e.oid, stop: false });
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})\n/);
      if (m) stack.push({ oid: m[1], stop: false });
    }
  }
  return held;
}

export function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  const objects = repo.objects;
  const shallowSet = new Set(clientShallow);
  const held = collectHeld(objects, haves, shallowSet);

  // Walk wants by generation (depth-limited). Tag wants resolve to their target
  // commit at the same generation, and the tag object itself is always sent.
  const wantCommits: string[] = [];
  const extraOids = new Set<string>();
  const boundary = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = wants.map((oid) => ({ oid, gen: 0 }));
  let qi = 0;
  while (qi < queue.length) {
    const { oid, gen } = queue[qi++];
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extraOids.add(oid);
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})\n/);
      if (m) queue.push({ oid: m[1], gen });
      continue;
    }
    if (obj.type !== 'commit') continue;
    wantCommits.push(oid);
    if (depth !== null && gen === depth - 1) boundary.add(oid);
    if (depth !== null && gen >= depth - 1) continue;
    for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, gen: gen + 1 });
  }

  const wantOids = collectWantOids(objects, wantCommits);
  for (const oid of extraOids) wantOids.add(oid);
  const toSend: string[] = [];
  for (const oid of wantOids) if (!held.has(oid)) toSend.push(oid);
  toSend.sort();

  // Shallow bookkeeping (only needed when the client has shallow commits).
  const after = new Set([...held, ...toSend]);
  const shallowOut = new Set<string>(boundary);
  const unshallowOut = new Set<string>();
  if (clientShallow.length === 0) {
    const knownHaves = haves.filter((h) => objects.has(h));
    const nak = haves.length === 0 || knownHaves.length !== haves.length;
    return { toSend, shallowOut: [...shallowOut].sort(), unshallowOut: [], ackOids: nak ? [] : knownHaves, nak };
  }
  const wantAncestors = collectCommits(objects, wants[0] ?? '');
  for (const w of wants.slice(1)) for (const c of collectCommits(objects, w)) wantAncestors.add(c);
  for (const s of clientShallow) {
    if (!wantAncestors.has(s) && !haves.includes(s)) continue;
    const obj = objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => after.has(p))) unshallowOut.add(s);
    else shallowOut.add(s);
  }
  // Boundary commits that were already unshallowed stay out of the shallow list.
  for (const s of unshallowOut) shallowOut.delete(s);

  const knownHaves = haves.filter((h) => objects.has(h));
  const nak = haves.length === 0 || knownHaves.length !== haves.length;
  return {
    toSend,
    shallowOut: [...shallowOut].sort(),
    unshallowOut: [...unshallowOut].sort(),
    ackOids: nak ? [] : knownHaves,
    nak,
  };
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function refLines(repo: Repo): Array<{ oid: string; name: string }> {
  const out: Array<{ oid: string; name: string }> = [];
  for (const name of [...repo.refs.keys()].sort()) out.push({ oid: repo.refs.get(name)!, name });
  return out;
}

function peeledOid(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})\n/);
  return m ? m[1] : null;
}

/** v2 upload-pack advertisement: `# service` + `version 2` + capabilities + flush. */
export function advertiseV2(): Buffer {
  const parts = [
    pktLine('# service=git-upload-pack\n'),
    pktLine('version 2\n'),
    pktLine('agent=' + AGENT + '\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ];
  return Buffer.concat(parts);
}

/** v0 upload-pack advertisement. */
export function advertiseV0(repo: Repo): Buffer {
  const caps = `side-band-64k thin-pack ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine('0000000000000000000000000000000000000000 capabilities^{}\0' + caps + '\n'));
  } else {
    refs.forEach((r, i) => {
      const suffix = i === 0 ? '\0' + caps : '';
      parts.push(pktLine(`${r.oid} ${r.name}${suffix}\n`));
      const peeled = peeledOid(repo, r.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${r.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v0 receive-pack advertisement. */
export function advertiseReceive(repo: Repo): Buffer {
  const caps = `report-status side-band-64k delete-refs agent=${AGENT} symref=HEAD:refs/heads/main`;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine('0000000000000000000000000000000000000000 capabilities^{}\0' + caps + '\n'));
  } else {
    refs.forEach((r, i) => {
      const suffix = i === 0 ? '\0' + caps : '';
      parts.push(pktLine(`${r.oid} ${r.name}${suffix}\n`));
      const peeled = peeledOid(repo, r.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${r.name}^{}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v2 handlers
// ---------------------------------------------------------------------------

export interface V2Request {
  command: string;
  args: string[];
}

/** Parse a v2 request body: pkt-lines up to flush, split by the delim marker. */
export function parseV2Request(buf: Buffer): V2Request {
  const { lines } = parsePktLines(buf);
  const args: string[] = [];
  let command = '';
  for (const l of lines) {
    const t = lineText(l);
    if (t === '') continue;
    if (t.startsWith('command=')) command = t.slice(8);
    else args.push(t);
  }
  return { command, args };
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice(11));
  const lines: Buffer[] = [];
  const headOid = repo.refs.get('refs/heads/main');
  const emit = (oid: string, name: string, symref?: string, peeled?: string | null) => {
    if (prefixes.length > 0 && !prefixes.some((p) => name.startsWith(p))) return;
    let line = `${oid} ${name}`;
    if (symref) line += ` symref-target:${symref}`;
    if (peeled) line += ` peeled:${peeled}`;
    lines.push(pktLine(line + '\n'));
  };
  if (headOid) {
    emit(headOid, 'HEAD', 'refs/heads/main');
  } else {
    lines.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  for (const r of refLines(repo)) {
    emit(r.oid, r.name, undefined, peel ? peeledOid(repo, r.oid) : null);
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

function fetchResponse(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5));
    else if (a.startsWith('have ')) haves.push(a.slice(5));
    else if (a.startsWith('shallow ')) shallow.push(a.slice(8));
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7), 10);
  }
  const plan = computeFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.nak) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of plan.ackOids) parts.push(pktLine(`ACK ${oid}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(DELIM);
  if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  const pack = writePack(repo, plan.toSend);
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

export function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const req = parseV2Request(body);
  if (req.command === 'ls-refs') return lsRefsResponse(repo, req.args);
  if (req.command === 'fetch') return fetchResponse(repo, req.args);
  throw new Error(`unknown v2 command: ${req.command}`);
}

// ---------------------------------------------------------------------------
// v0 fetch handler
// ---------------------------------------------------------------------------

export function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  // Section 1 (wants/shallow/deepen) until flush, section 2 (haves/done) until flush.
  const first = parsePktLines(body);
  const wants: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const l of first.lines) {
    const t = lineText(l);
    const want = t.match(/^want ([0-9a-f]{40})/);
    if (want) wants.push(want[1]);
    else if (t.startsWith('shallow ')) shallow.push(t.slice(8));
    else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7), 10);
  }
  const second = parsePktLines(body, first.next);
  const haves: string[] = [];
  for (const l of second.lines) {
    const t = lineText(l);
    const have = t.match(/^have ([0-9a-f]{40})/);
    if (have) haves.push(have[1]);
  }
  const plan = computeFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(pktLine('NAK\n'));
  else for (const oid of plan.ackOids) parts.push(pktLine(`ACK ${oid}\n`));
  for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = writePack(repo, plan.toSend);
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack (v0 push)
// ---------------------------------------------------------------------------

export interface PushResult {
  status: number;
  body: Buffer;
}

export function handleReceivePack(repo: Repo, body: Buffer): PushResult {
  let parsed;
  try {
    parsed = parsePktLines(body);
  } catch {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'malformed push request' })) };
  }
  interface Cmd {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const cmds: Cmd[] = [];
  for (const l of parsed.lines) {
    let t = lineText(l);
    const nul = t.indexOf('\0');
    if (nul >= 0) t = t.slice(0, nul);
    const m = t.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (!m) return { status: 400, body: Buffer.from(JSON.stringify({ message: 'malformed push command' })) };
    cmds.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  if (cmds.length === 0) return { status: 400, body: Buffer.from(JSON.stringify({ message: 'no push commands' })) };

  const packBytes = body.subarray(parsed.next);
  let unpackOk = true;
  let unpackErr = '';
  // A delete-only push carries no pack at all (git sends none there either).
  if (packBytes.length > 0) {
    try {
      readPack(repo, packBytes);
    } catch (e) {
      unpackOk = false;
      unpackErr = e instanceof Error ? e.message : 'unpack failed';
    }
  }

  const ZERO = '0000000000000000000000000000000000000000';
  const report: string[] = [];
  if (!unpackOk) {
    report.push(`unpack ${unpackErr}`);
    for (const c of cmds) report.push(`ng ${c.ref} unpack failed`);
  } else {
    report.push('unpack ok');
    for (const c of cmds) {
      const current = repo.refs.get(c.ref);
      if (c.newOid === ZERO) {
        // delete
        if (!current || current !== c.oldOid) {
          report.push(`ng ${c.ref} delete failed`);
        } else {
          repo.refs.delete(c.ref);
          report.push(`ok ${c.ref}`);
        }
        continue;
      }
      const tip = repo.objects.get(c.newOid);
      if (!tip) {
        report.push(`ng ${c.ref} object not found`);
        continue;
      }
      if (!current) {
        if (c.oldOid !== ZERO) {
          report.push(`ng ${c.ref} non-fast-forward`);
          continue;
        }
        repo.refs.set(c.ref, c.newOid);
        report.push(`ok ${c.ref}`);
        continue;
      }
      if (current !== c.oldOid) {
        report.push(`ng ${c.ref} non-fast-forward`);
        continue;
      }
      if (c.newOid === c.oldOid) {
        report.push(`ok ${c.ref}`);
        continue;
      }
      // Fast-forward check for commits: the new tip must descend from the old tip
      // (isAncestor stops as soon as the old tip is found — no full-history walk).
      // Non-commit targets (annotated tags) have no ancestry: old-match is enough.
      if (tip.type === 'commit' && !isAncestor(repo.objects, c.oldOid, c.newOid)) {
        report.push(`ng ${c.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(c.ref, c.newOid);
      report.push(`ok ${c.ref}`);
    }
  }

  const parts: Buffer[] = [];
  for (const line of report) {
    const inner = pktLine(line + '\n');
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner])));
  }
  parts.push(FLUSH);
  return { status: 200, body: Buffer.concat(parts) };
}
