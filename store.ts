// In-memory store for the forge: repos, issues, pull requests, and real git objects.
// Node 24 stdlib only. All object ids are real git SHA-1s.
import { createHash } from 'node:crypto';
import { b64encode } from './httputil.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FIXED_TS = 1700000000;
export const FIXED_ISO = '2026-11-14T06:30:00.000Z';
export const DEFAULT_BRANCH = 'main';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  isDir: boolean;
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  /** Cached REST JSON string for the hot GET-issue path. */
  json: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  databaseId: number;
  order: number;
  createdAt: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  issueOrder: number[];
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  labels: Map<string, Label>;
  json: string;
}

// ---------------------------------------------------------------------------
// Git object primitives (real SHA-1, git wire formats)
// ---------------------------------------------------------------------------

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function oidToBytes(oid: string): Buffer {
  return Buffer.from(oid, 'hex');
}

/** Sort key used by git for tree entries: dirs compare as name + '/'. */
function treeSortKey(e: TreeEntry): string {
  return e.isDir ? e.name + '/' : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(oidToBytes(e.oid));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp);
    const mode = data.subarray(i, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid, isDir: mode === '40000' });
    i = nul + 21;
  }
  return out;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(tree: string, parents: string[], message: string, ts = FIXED_TS): Buffer {
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000\n`;
  s += `committer ${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000\n`;
  s += `\n${message}`;
  return Buffer.from(s, 'utf8');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildTag(object: string, type: ObjType, tag: string, message: string, ts = FIXED_TS): Buffer {
  const s =
    `object ${object}\ntype ${type}\ntag ${tag}\n` +
    `tagger ${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000\n\n${message}`;
  return Buffer.from(s, 'utf8');
}

/** All object ids reachable from the given roots (commits, trees, blobs, tags). */
export function collectReachable(objects: Map<string, GitObj>, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})\n/);
      if (m) stack.push(m[1]);
    }
  }
  return seen;
}

/** Commit ids reachable from a commit (following parents only). */
export function collectCommits(objects: Map<string, GitObj>, root: string): Set<string> {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return seen;
}

export function isAncestor(objects: Map<string, GitObj>, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** Nearest common ancestor commit (BFS by generation, first hit wins). */
export function findMergeBase(objects: Map<string, GitObj>, a: string, b: string): string | null {
  if (!objects.has(a) || !objects.has(b)) return null;
  const ancA = collectCommits(objects, a);
  // BFS from b, preferring nearer commits.
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

/** Flatten a tree into path -> {oid, mode} for files only (dirs recursed). */
export function flattenTree(objects: Map<string, GitObj>, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = pre + e.name;
      if (e.isDir) walk(e.oid, path + '/');
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldOid: string | null;
  newOid: string | null;
}

function countLines(objects: Map<string, GitObj>, oid: string | null): number {
  if (!oid) return 0;
  const obj = objects.get(oid);
  if (!obj || obj.type !== 'blob') return 0;
  const text = obj.data.toString('utf8');
  if (text.length === 0) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Diff two trees (flattened) into a GitHub-style file list. */
export function diffTrees(objects: Map<string, GitObj>, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = baseTree ? flattenTree(objects, baseTree) : new Map<string, { oid: string; mode: string }>();
  const head = headTree ? flattenTree(objects, headTree) : new Map<string, { oid: string; mode: string }>();
  const out: FileChange[] = [];
  const names = new Set([...base.keys(), ...head.keys()]);
  for (const name of [...names].sort()) {
    const b = base.get(name);
    const h = head.get(name);
    if (b && !h) {
      const d = countLines(objects, b.oid);
      out.push({ filename: name, status: 'removed', additions: 0, deletions: d, changes: d, oldOid: b.oid, newOid: null });
    } else if (!b && h) {
      const a = countLines(objects, h.oid);
      out.push({ filename: name, status: 'added', additions: a, deletions: 0, changes: a, oldOid: null, newOid: h.oid });
    } else if (b && h && b.oid !== h.oid) {
      const a = countLines(objects, h.oid);
      const d = countLines(objects, b.oid);
      out.push({ filename: name, status: 'modified', additions: a, deletions: d, changes: a + d, oldOid: b.oid, newOid: h.oid });
    }
  }
  return out;
}

/** True when base and head changed the same file differently since the merge-base (merge conflict). */
export function hasMergeConflict(objects: Map<string, GitObj>, baseTree: string | null, headTree: string | null, mergeBaseTree: string | null): boolean {
  const baseChanges = new Map<string, FileChange>();
  for (const c of diffTrees(objects, mergeBaseTree, baseTree)) baseChanges.set(c.filename, c);
  for (const c of diffTrees(objects, mergeBaseTree, headTree)) {
    const b = baseChanges.get(c.filename);
    if (!b) continue;
    // Both sides touched the file: conflict unless they made the identical change.
    if (b.newOid !== c.newOid || b.status !== c.status) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// REST / GraphQL view shapes
// ---------------------------------------------------------------------------

export function repoGlobalId(repo: Repo): string {
  return b64encode(`Repository:${repo.databaseId}`);
}

export function issueGlobalId(repo: Repo, n: number): string {
  return b64encode(`Issue:${repo.databaseId}:${n}`);
}

export function prGlobalId(repo: Repo, n: number): string {
  return b64encode(`PullRequest:${repo.databaseId}:${n}`);
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return b64encode(`IssueComment:${repo.databaseId}:${issueNumber}:${commentId}`);
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: DEFAULT_BRANCH,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    has_issues: true,
    has_pull_requests: true,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: issue.user, id: issue.user === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
  };
}

export function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: prGlobalId(repo, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  repos = new Map<string, Repo>();
  repoList: Repo[] = [];
  nextRepoId = 1;
  nextRepoOrder = 1;
  nextGlobalIssueId = 1;
  nextGlobalPrId = 1;
  nextGlobalCommentId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      name,
      owner,
      description,
      isPrivate,
      databaseId: this.nextRepoId++,
      order: this.nextRepoOrder++,
      createdAt: FIXED_ISO,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      issueOrder: [],
      pulls: new Map(),
      nextNumber: 1,
      labels: new Map(),
      json: '',
    };
    repo.json = JSON.stringify(repoJson(repo));
    this.repos.set(this.key(owner, name), repo);
    this.repoList.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (!repo) return false;
    this.repos.delete(this.key(owner, name));
    const i = this.repoList.indexOf(repo);
    if (i >= 0) this.repoList.splice(i, 1);
    return true;
  }

  createLabel(repo: Repo, name: string, color = 'ededed'): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): { issue?: Issue; error?: string } {
    const labels: Label[] = [];
    for (const n of labelNames) {
      const l = repo.labels.get(n);
      if (!l) return { error: `Label '${n}' does not exist` };
      labels.push(l);
    }
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: this.nextGlobalIssueId++,
      number,
      title,
      body,
      state: 'open',
      labels,
      user: VIEWER_LOGIN,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      comments: [],
      json: '',
    };
    issue.json = JSON.stringify(issueJson(repo, issue));
    repo.issues.set(number, issue);
    repo.issueOrder.push(number);
    return { issue };
  }

  patchIssue(repo: Repo, issue: Issue, patch: { title?: string; body?: string; state?: 'open' | 'closed' }): void {
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined) issue.state = patch.state;
    issue.updatedAt = FIXED_ISO;
    issue.json = JSON.stringify(issueJson(repo, issue));
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const c: Comment = { id: this.nextGlobalCommentId++, body, user: VIEWER_LOGIN, createdAt: FIXED_ISO };
    issue.comments.push(c);
    return c;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): { pr?: PullRequest; error?: string } {
    const headRef = `refs/heads/${head}`;
    const baseRef = `refs/heads/${base}`;
    const headSha = repo.refs.get(headRef);
    const baseSha = repo.refs.get(baseRef);
    if (!headSha) return { error: `Head branch '${head}' not found` };
    if (!baseSha) return { error: `Base branch '${base}' not found` };
    for (const p of repo.pulls.values()) {
      if (p.state === 'open' && p.headRef === head) return { error: 'A pull request already exists for this head branch' };
    }
    const number = repo.nextNumber++;
    const pr: PullRequest = {
      id: this.nextGlobalPrId++,
      number,
      title,
      body,
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
    };
    repo.pulls.set(number, pr);
    return { pr };
  }

  /** Mergeability: no conflicting file changes vs the merge-base. */
  prMergeable(repo: Repo, pr: PullRequest): boolean {
    const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    if (!headSha || !baseSha) return false;
    const mb = findMergeBase(repo.objects, baseSha, headSha);
    const mbTree = mb ? parseCommit(repo.objects.get(mb)!.data).tree : null;
    const baseTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headSha)!.data).tree;
    return !hasMergeConflict(repo.objects, baseTree, headTree, mbTree);
  }

  /** Squash-style merge: one merge commit with tree = head tree, parents [base, head]. */
  mergePull(repo: Repo, pr: PullRequest): { ok: boolean; status: number; sha?: string; message?: string } {
    const headSha = repo.refs.get(`refs/heads/${pr.headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (!headSha || !baseSha) return { ok: false, status: 404, message: 'Branch not found' };
    if (pr.merged || pr.state !== 'open') return { ok: false, status: 405, message: 'Pull request is already merged' };
    if (!this.prMergeable(repo, pr)) return { ok: false, status: 405, message: 'Merge conflict' };
    const headTree = parseCommit(repo.objects.get(headSha)!.data).tree;
    const mergeCommit = buildCommit(headTree, [baseSha, headSha], `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}`);
    const mergeSha = storeObject(repo, 'commit', mergeCommit);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_ISO;
    pr.mergeCommitSha = mergeSha;
    pr.updatedAt = FIXED_ISO;
    return { ok: true, status: 200, sha: mergeSha, message: `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}` };
  }

  /** Commits reachable from a branch tip, newest first (BFS by generation). */
  branchCommits(repo: Repo, branch: string): string[] {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return out;
  }

  /** Resolve a ref name (branch) or raw oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (!ref) return repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? null;
    const byBranch = repo.refs.get(`refs/heads/${ref}`);
    if (byBranch) return byBranch;
    const obj = repo.objects.get(ref);
    if (obj && obj.type === 'commit') return ref;
    return null;
  }

  /** Replace/insert a file in a tree, building new trees bottom-up. Returns the new root tree oid. */
  updateTree(repo: Repo, treeOid: string | null, segments: string[], blobOid: string | null): string {
    const entries = new Map<string, TreeEntry>();
    if (treeOid) {
      for (const e of parseTree(repo.objects.get(treeOid)!.data)) entries.set(e.name, e);
    }
    const [head, ...rest] = segments;
    if (rest.length === 0) {
      if (blobOid) entries.set(head, { mode: '100644', name: head, oid: blobOid, isDir: false });
      else entries.delete(head);
    } else {
      const sub = entries.get(head);
      const subTree = sub && sub.isDir ? sub.oid : null;
      const newSub = this.updateTree(repo, subTree, rest, blobOid);
      entries.set(head, { mode: '40000', name: head, oid: newSub, isDir: true });
    }
    return storeObject(repo, 'tree', buildTree([...entries.values()]));
  }

  /** Read a tree path: returns the entry (file or dir) at path, or null. */
  lookupPath(repo: Repo, treeOid: string, segments: string[]): TreeEntry | null {
    let cur = treeOid;
    for (let i = 0; i < segments.length; i++) {
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'tree') return null;
      const e = parseTree(obj.data).find((x) => x.name === segments[i]);
      if (!e) return null;
      if (i === segments.length - 1) return e;
      if (!e.isDir) return null;
      cur = e.oid;
    }
    return null;
  }
}
