// REST v3 API (/api/v3). JSON everywhere; every reply carries X-GitHub-Request-Id.
// Node 24 stdlib only.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_BRANCH, FIXED_ISO, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './store.ts';
import type { Repo, Store } from './store.ts';
import { nextRequestId, parseJsonBody, readBody, sendJson, sendText } from './httputil.ts';
import { buildCommit, diffTrees, findMergeBase, parseCommit, parseTree, prJson, repoJson, storeObject } from './store.ts';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  query: URLSearchParams;
}

function rid(res: ServerResponse): Record<string, string> {
  return { 'X-GitHub-Request-Id': nextRequestId() };
}

function ok(res: ServerResponse, status: number, obj: unknown, extra?: Record<string, string>): void {
  sendJson(res, status, obj, { ...rid(res), ...(extra ?? {}) });
}

function okText(res: ServerResponse, status: number, text: string, extra?: Record<string, string>): void {
  sendText(res, status, text, 'application/json', { ...rid(res), ...(extra ?? {}) });
}

function fail(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message }, rid(res));
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; perPage: number; pageNum: number; total: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum, total: items.length };
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, perPage: number, pageNum: number, total: number): string | null {
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${path}`;
  const links: string[] = [];
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (pageNum < lastPage) {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(pageNum + 1));
    links.push(`<${base}?${q.toString()}>; rel="next"`);
  }
  if (pageNum > 1) {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(pageNum - 1));
    links.push(`<${base}?${q.toString()}>; rel="prev"`);
  }
  const ql = new URLSearchParams(query);
  ql.set('per_page', String(perPage));
  ql.set('page', String(lastPage));
  links.push(`<${base}?${ql.toString()}>; rel="last"`);
  return links.length > 0 ? links.join(', ') : null;
}

function pageResponse<T>(ctx: Ctx, items: T[], toJson: (x: T) => unknown): void {
  const { page, perPage, pageNum, total } = paginate(items, ctx.query);
  const link = linkHeader(ctx.req, new URL(ctx.req.url ?? '/', 'http://x').pathname, ctx.query, perPage, pageNum, total);
  ok(ctx.res, 200, page.map(toJson), link ? { Link: link } : undefined);
}

function viewerJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
}

export async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<boolean> {
  if (!pathname.startsWith('/api/v3')) return false;
  const ctx: Ctx = { req, res, store, query };
  // Auth: every /api/v3 route requires the shop token.
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const auth = req.headers.authorization ?? '';
  if (token === '' || auth !== `Bearer ${token}`) {
    fail(res, 401, 'Bad credentials');
    return true;
  }
  const segs = pathname.split('/').filter((s) => s.length > 0); // ['api','v3',...]
  const rest = segs.slice(2);
  const method = req.method ?? 'GET';

  // GET /api/v3/ — API root.
  if (rest.length === 0) {
    if (method !== 'GET') return fail(res, 405, 'Method not allowed'), true;
    ok(res, 200, {}, { 'X-OAuth-Scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/user
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') return fail(res, 405, 'Method not allowed'), true;
    ok(res, 200, viewerJson());
    return true;
  }

  // /api/v3/user/repos
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      pageResponse(ctx, store.repoList.filter((r) => r.owner === VIEWER_LOGIN), (r) => JSON.parse(r.json));
      return true;
    }
    if (method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || body === null || typeof body !== 'object') return fail(res, 400, 'Invalid JSON'), true;
      const b = body as Record<string, unknown>;
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (name === '') return fail(res, 400, 'name is required'), true;
      if (store.getRepo(VIEWER_LOGIN, name)) return fail(res, 422, 'Repository already exists'), true;
      const repo = store.createRepo(VIEWER_LOGIN, name, typeof b.description === 'string' ? b.description : '', b.private === true);
      okText(res, 201, repo.json);
      return true;
    }
    return fail(res, 405, 'Method not allowed'), true;
  }

  // /api/v3/meta — not part of /api/v3 here; handled in app.ts (GET /meta is top-level).
  // /api/v3/repos/:owner/:repo/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const repo = store.getRepo(owner, name);
    const tail = rest.slice(3);
    if (!repo) return fail(res, 404, 'Not Found'), true;
    return handleRepo(ctx, repo, tail, method);
  }

  return fail(res, 404, 'Not Found'), true;
}

async function handleRepo(ctx: Ctx, repo: Repo, tail: string[], method: string): Promise<boolean> {
  const { req, res, store, query } = ctx;

  // Repo itself: GET / PATCH / DELETE /api/v3/repos/:o/:r
  if (tail.length === 0) {
    if (method === 'GET') return okText(res, 200, repo.json), true;
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, rid(res));
      res.end();
      return true;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || body === null || typeof body !== 'object') return fail(res, 400, 'Invalid JSON'), true;
      const b = body as Record<string, unknown>;
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.isPrivate = b.private;
      repo.json = JSON.stringify(repoJson(repo));
      return okText(res, 200, repo.json), true;
    }
    return fail(res, 405, 'Method not allowed'), true;
  }

  const head = tail[0];

  // --- branches ---
  if (head === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort().map((r) => ({
        name: r.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(r)! },
      }));
      return ok(res, 200, list), true;
    }
    if (tail.length === 2 && method === 'GET') {
      const oid = repo.refs.get(`refs/heads/${decodeURIComponent(tail[1])}`);
      if (!oid) return fail(res, 404, 'Branch not found'), true;
      return ok(res, 200, { name: decodeURIComponent(tail[1]), commit: { sha: oid } }), true;
    }
    return fail(res, 404, 'Not Found'), true;
  }

  // --- commits ---
  if (head === 'commits' && method === 'GET' && tail.length === 1) {
    const branch = query.get('sha') ?? DEFAULT_BRANCH;
    const ids = store.branchCommits(repo, branch);
    const out = ids.map((oid) => {
      const c = parseCommit(repo.objects.get(oid)!.data);
      return {
        sha: oid,
        commit: {
          message: c.message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
        },
        parents: c.parents.map((p) => ({ sha: p })),
      };
    });
    return ok(res, 200, out), true;
  }

  // --- git/refs ---
  if (head === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || body === null || typeof body !== 'object') return fail(res, 400, 'Invalid JSON'), true;
      const b = body as Record<string, unknown>;
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sha = typeof b.sha === 'string' ? b.sha : '';
      if (!ref.startsWith('refs/heads/') || sha.length !== 40) return fail(res, 422, 'Invalid ref'), true;
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') return fail(res, 422, 'Object does not exist'), true;
      if (repo.refs.has(ref)) return fail(res, 422, 'Reference already exists'), true;
      repo.refs.set(ref, sha);
      return ok(res, 201, { ref, object: { sha } }), true;
    }
    if (method === 'GET' && tail.length >= 3) {
      const refPath = tail.slice(2).map(decodeURIComponent).join('/');
      const full = refPath.startsWith('refs/') ? refPath : `refs/${refPath}`;
      const oid = repo.refs.get(full);
      if (!oid) return fail(res, 404, 'Reference not found'), true;
      return ok(res, 200, { ref: full, object: { sha: oid } }), true;
    }
    return fail(res, 404, 'Not Found'), true;
  }

  // --- contents ---
  if (head === 'contents') {
    return handleContents(ctx, repo, tail.slice(1), method);
  }

  // --- labels ---
  if (head === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      return ok(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color }))), true;
    }
    if (method === 'POST' && tail.length === 1) {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || body === null || typeof body !== 'object') return fail(res, 400, 'Invalid JSON'), true;
      const b = body as Record<string, unknown>;
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (name === '') return fail(res, 400, 'name is required'), true;
      const label = store.createLabel(repo, name, typeof b.color === 'string' ? b.color.replace('#', '') : 'ededed');
      return ok(res, 201, { name: label.name, color: label.color }), true;
    }
    return fail(res, 404, 'Not Found'), true;
  }

  // --- issues ---
  if (head === 'issues') {
    return handleIssues(ctx, repo, tail.slice(1), method);
  }

  // --- pulls ---
  if (head === 'pulls') {
    return handlePulls(ctx, repo, tail.slice(1), method);
  }

  return fail(res, 404, 'Not Found'), true;
}

// ---------------------------------------------------------------------------
// Contents API
// ---------------------------------------------------------------------------

async function handleContents(ctx: Ctx, repo: Repo, tail: string[], method: string): Promise<boolean> {
  const { req, res, store, query } = ctx;
  const filePath = tail.map(decodeURIComponent).join('/');
  const segments = filePath.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return fail(res, 404, 'Not Found'), true;
  const ref = query.get('ref') ?? undefined;
  const branch = ref ?? DEFAULT_BRANCH;

  if (method === 'GET') {
    const tip = store.resolveRef(repo, ref ?? '');
    if (!tip) return fail(res, 404, 'Not Found'), true;
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    // Directory listing when the path resolves to a tree.
    const entry = store.lookupPath(repo, tree, segments);
    if (!entry) return fail(res, 404, 'Not Found'), true;
    if (entry.isDir) {
      const obj = repo.objects.get(entry.oid)!;
      const items = parseTree(obj.data).map((e) => ({
        type: e.isDir ? 'dir' : 'file',
        name: e.name,
        path: `${filePath}/${e.name}`,
        sha: e.oid,
        size: e.isDir ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
      }));
      return ok(res, 200, items), true;
    }
    const blob = repo.objects.get(entry.oid);
    if (!blob) return fail(res, 404, 'Not Found'), true;
    return ok(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: entry.oid,
      size: blob.data.length,
      name: segments[segments.length - 1],
      path: filePath,
    }), true;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = parseJsonBody(await readBody(req));
    if (body === undefined || body === null || typeof body !== 'object') return fail(res, 400, 'Invalid JSON'), true;
    const b = body as Record<string, unknown>;
    const bodyBranch = typeof b.branch === 'string' ? b.branch : branch;
    const tip = repo.refs.get(`refs/heads/${bodyBranch}`);
    const message = typeof b.message === 'string' ? b.message : `${method === 'PUT' ? 'Update' : 'Delete'} ${filePath}`;

    if (method === 'PUT') {
      const contentB64 = typeof b.content === 'string' ? b.content : '';
      if (contentB64 === '') return fail(res, 400, 'content is required'), true;
      const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      // First commit on an empty repo: no parent, the branch is created here.
      if (!tip) {
        if (repo.refs.size > 0) return fail(res, 404, 'Branch not found'), true;
        const blobOid = storeObject(repo, 'blob', content);
        const newTree = store.updateTree(repo, null, segments, blobOid);
        const newCommit = buildCommit(newTree, [], message);
        const commitOid = storeObject(repo, 'commit', newCommit);
        repo.refs.set(`refs/heads/${bodyBranch}`, commitOid);
        return ok(res, 201, {
          content: { sha: blobOid, encoding: 'base64', name: segments[segments.length - 1], path: filePath },
          commit: { sha: commitOid },
        }), true;
      }
      const commitInfo = parseCommit(repo.objects.get(tip)!.data);
      const current = store.lookupPath(repo, commitInfo.tree, segments);
      if (current && typeof b.sha === 'string' && b.sha !== current.oid) return fail(res, 409, 'sha does not match'), true;
      if (current && b.sha === undefined) return fail(res, 422, 'sha is required to update a file'), true;
      const blobOid = storeObject(repo, 'blob', content);
      const newTree = store.updateTree(repo, commitInfo.tree, segments, blobOid);
      const newCommit = buildCommit(newTree, [tip], message);
      const commitOid = storeObject(repo, 'commit', newCommit);
      repo.refs.set(`refs/heads/${bodyBranch}`, commitOid);
      return ok(res, current ? 200 : 201, {
        content: { sha: blobOid, encoding: 'base64', name: segments[segments.length - 1], path: filePath },
        commit: { sha: commitOid },
      }), true;
    }

    // DELETE
    if (!tip) return fail(res, 404, 'Branch not found'), true;
    const commitInfo = parseCommit(repo.objects.get(tip)!.data);
    const current = store.lookupPath(repo, commitInfo.tree, segments);
    if (!current) return fail(res, 404, 'Not Found'), true;
    if (typeof b.sha === 'string' && b.sha !== current.oid) return fail(res, 409, 'sha does not match'), true;
    const newTree = store.updateTree(repo, commitInfo.tree, segments, null);
    const newCommit = buildCommit(newTree, [tip], message);
    const commitOid = storeObject(repo, 'commit', newCommit);
    repo.refs.set(`refs/heads/${bodyBranch}`, commitOid);
    return ok(res, 200, { commit: { sha: commitOid } }), true;
  }

  return fail(res, 404, 'Not Found'), true;
}

// ---------------------------------------------------------------------------
// Issues API
// ---------------------------------------------------------------------------

async function handleIssues(ctx: Ctx, repo: Repo, tail: string[], method: string): Promise<boolean> {
  const { req, res, store, query } = ctx;

  // POST /issues — create
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || body === null || typeof body !== 'object') return fail(res, 400, 'Invalid JSON'), true;
      const b = body as Record<string, unknown>;
      const title = typeof b.title === 'string' ? b.title : '';
      if (title === '') return fail(res, 400, 'title is required'), true;
      const labels = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
      const { issue, error } = store.createIssue(repo, title, typeof b.body === 'string' ? b.body : '', labels);
      if (error) return fail(res, 422, error), true;
      return okText(res, 201, issue!.json), true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issueOrder.map((n) => repo.issues.get(n)!);
      if (state !== 'all') list = list.filter((i) => i.state === state);
      if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      pageResponse(ctx, list, (i) => JSON.parse(i.json));
      return true;
    }
    return fail(res, 405, 'Method not allowed'), true;
  }

  const n = parseInt(tail[0], 10);
  if (Number.isNaN(n)) return fail(res, 404, 'Not Found'), true;
  const issue = repo.issues.get(n);
  if (!issue) return fail(res, 404, 'Not Found'), true;

  // /issues/:n/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || body === null || typeof body !== 'object') return fail(res, 400, 'Invalid JSON'), true;
      const b = body as Record<string, unknown>;
      const c = store.createComment(repo, issue, typeof b.body === 'string' ? b.body : '');
      return ok(res, 201, { id: c.id, body: c.body, user: { login: c.user, type: 'User' }, created_at: c.createdAt }), true;
    }
    if (method === 'GET') {
      return ok(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.user, type: 'User' }, created_at: c.createdAt }))), true;
    }
    return fail(res, 405, 'Method not allowed'), true;
  }

  if (tail.length === 1) {
    if (method === 'GET') return okText(res, 200, issue.json), true;
    if (method === 'PATCH') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || body === null || typeof body !== 'object') return fail(res, 400, 'Invalid JSON'), true;
      const b = body as Record<string, unknown>;
      const patch: { title?: string; body?: string; state?: 'open' | 'closed' } = {};
      if (typeof b.title === 'string') patch.title = b.title;
      if (typeof b.body === 'string') patch.body = b.body;
      if (b.state === 'open' || b.state === 'closed') patch.state = b.state;
      store.patchIssue(repo, issue, patch);
      return okText(res, 200, issue.json), true;
    }
    return fail(res, 405, 'Method not allowed'), true;
  }

  return fail(res, 404, 'Not Found'), true;
}

// ---------------------------------------------------------------------------
// Pulls API
// ---------------------------------------------------------------------------

async function handlePulls(ctx: Ctx, repo: Repo, tail: string[], method: string): Promise<boolean> {
  const { req, res, store, query } = ctx;

  if (tail.length === 0) {
    if (method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (body === undefined || body === null || typeof body !== 'object') return fail(res, 400, 'Invalid JSON'), true;
      const b = body as Record<string, unknown>;
      const title = typeof b.title === 'string' ? b.title : '';
      const head = typeof b.head === 'string' ? b.head : '';
      const base = typeof b.base === 'string' ? b.base : DEFAULT_BRANCH;
      if (title === '' || head === '') return fail(res, 400, 'title and head are required'), true;
      const { pr, error } = store.createPull(repo, title, typeof b.body === 'string' ? b.body : '', head, base);
      if (error) return fail(res, 422, error), true;
      return ok(res, 201, prJson(repo, pr!)), true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = [...repo.pulls.values()].filter((p) => (state === 'all' ? true : p.state === state));
      return ok(res, 200, list.map((p) => prJson(repo, p))), true;
    }
    return fail(res, 405, 'Method not allowed'), true;
  }

  const n = parseInt(tail[0], 10);
  if (Number.isNaN(n)) return fail(res, 404, 'Not Found'), true;
  const pr = repo.pulls.get(n);
  if (!pr) return fail(res, 404, 'Not Found'), true;

  if (tail.length === 1 && method === 'GET') {
    const out = prJson(repo, pr) as Record<string, unknown>;
    out.mergeable = store.prMergeable(repo, pr);
    return ok(res, 200, out), true;
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    const mb = findMergeBase(repo.objects, baseSha, headSha);
    const mbTree = mb ? parseCommit(repo.objects.get(mb)!.data).tree : null;
    const headTree = parseCommit(repo.objects.get(headSha)!.data).tree;
    const files = diffTrees(repo.objects, mbTree, headTree).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    }));
    return ok(res, 200, files), true;
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    const result = store.mergePull(repo, pr);
    if (!result.ok) return fail(res, result.status, result.message ?? 'Merge failed'), true;
    return ok(res, 200, { sha: result.sha, merged: true, message: result.message }), true;
  }

  return fail(res, 404, 'Not Found'), true;
}
