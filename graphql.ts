// Minimal GraphQL executor for the fixed gh-style documents this forge answers.
// Node 24 stdlib only. Supports variables, aliases, arguments, nested selections
// and inline fragments (`... on Type { ... }`). Unknown fields -> 200 + errors.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_BRANCH, VIEWER_ID, VIEWER_LOGIN, commentGlobalId, diffTrees, findMergeBase, issueGlobalId, parseCommit, prGlobalId, repoGlobalId } from './store.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { b64decode, b64encode, parseJsonBody, readBody, sendJson } from './httputil.ts';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type GqlValue = string | number | boolean | null | GqlValue[] | { [k: string]: GqlValue } | { $var: string };

type SelNode =
  | { kind: 'field'; name: string; alias: string; args: Record<string, GqlValue>; sel: SelNode[] }
  | { kind: 'fragment'; type: string; sel: SelNode[] };

interface Operation {
  kind: 'query' | 'mutation';
  sel: SelNode[];
}

class ParseError extends Error {}

function tokenize(src: string): string[] {
  const toks: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { toks.push('...'); i += 3; continue; }
    if ('{}():!$=[]'.includes(c)) { toks.push(c); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      toks.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      toks.push(src.slice(i, j));
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(c)}`);
  }
  return toks;
}

class Parser {
  toks: string[];
  pos = 0;
  constructor(src: string) {
    this.toks = tokenize(src);
  }
  peek(): string | undefined {
    return this.toks[this.pos];
  }
  next(): string {
    const t = this.toks[this.pos++];
    if (t === undefined) throw new ParseError('unexpected end of document');
    return t;
  }
  expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new ParseError(`expected ${t}, got ${got}`);
  }
  parseDocument(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      // Optional operation name.
      if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') this.next();
      // Optional variable definitions.
      if (this.peek() === '(') this.skipVarDefs();
    }
    const sel = this.parseSelectionSet();
    return { kind, sel };
  }
  skipVarDefs(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t === '(' || t === '[' || t === '{') depth++;
      else if (t === ')' || t === ']' || t === '}') depth--;
    }
  }
  parseSelectionSet(): SelNode[] {
    this.expect('{');
    const out: SelNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new ParseError('unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }
  parseSelection(): SelNode {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const type = this.next();
        const sel = this.parseSelectionSet();
        return { kind: 'fragment', type, sel };
      }
      throw new ParseError('named fragments are not supported');
    }
    let name = this.next();
    let alias = name;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    let args: Record<string, GqlValue> = {};
    if (this.peek() === '(') args = this.parseArgs();
    let sel: SelNode[] = [];
    if (this.peek() === '{') sel = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, sel };
  }
  parseArgs(): Record<string, GqlValue> {
    this.expect('(');
    const out: Record<string, GqlValue> = {};
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      out[name] = this.parseValue();
    }
    this.expect(')');
    return out;
  }
  parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') return { $var: this.next() };
    if (t === '[') {
      const arr: GqlValue[] = [];
      while (this.peek() !== ']') arr.push(this.parseValue());
      this.expect(']');
      return arr;
    }
    if (t === '{') {
      const obj: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const k = this.next();
        this.expect(':');
        obj[k] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t);
    return t; // enum literal -> string
  }
}

function resolveVars(value: GqlValue, vars: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('$var' in value) return vars[(value as { $var: string }).$var] ?? null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveVars(v as GqlValue, vars);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => resolveVars(v, vars));
  return value;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type GqlObj =
  | { __kind: 'Query' }
  | { __kind: 'Mutation' }
  | { __kind: 'User'; login: string }
  | { __kind: 'Repository'; repo: Repo }
  | { __kind: 'BranchRef'; name: string }
  | { __kind: 'Issue'; repo: Repo; issue: Issue }
  | { __kind: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { __kind: 'IssueConnection'; items: Issue[]; repo: Repo; first: number | null; after: string | null }
  | { __kind: 'PullRequestConnection'; items: PullRequest[]; repo: Repo; first: number | null; after: string | null }
  | { __kind: 'FileConnection'; items: Array<{ path: string }>; first: number | null }
  | { __kind: 'IssueEdge'; issue: Issue; repo: Repo }
  | { __kind: 'PullRequestEdge'; pr: PullRequest; repo: Repo }
  | { __kind: 'FileEdge'; path: string }
  | { __kind: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { __kind: '__Type'; name: string }
  | { __kind: 'FieldDef'; name: string }
  | { __kind: 'EnumValue'; name: string }
  | { __kind: 'Comment'; id: string; body: string }
  | { __kind: 'CommentEdge'; comment: { __kind: 'Comment'; id: string; body: string } }
  | { __kind: 'CreateIssuePayload'; issue: Issue | null; repo: Repo }
  | { __kind: 'CloseIssuePayload'; issue: Issue | null; repo: Repo }
  | { __kind: 'CreatePullRequestPayload'; pr: PullRequest | null; repo: Repo }
  | { __kind: 'MergePullRequestPayload'; pr: PullRequest | null; repo: Repo }
  | { __kind: 'AddCommentPayload'; comment: { __kind: 'Comment'; id: string; body: string } | null };

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'url', 'createdAt', 'updatedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};

const TYPE_KIND: Record<string, string> = { Issue: 'OBJECT', PullRequest: 'OBJECT', Repository: 'OBJECT', SearchType: 'ENUM' };

class FieldError extends Error {}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = b64decode(id);
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function issueCursor(n: number): string {
  return b64encode(`cursor:${n}`);
}

function parseCursor(after: string | null): number | null {
  if (!after) return null;
  try {
    const text = b64decode(after);
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function connectionPage<T extends { number: number }>(items: T[], first: number | null, after: string | null): { page: T[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null } {
  const afterNum = parseCursor(after);
  let start = 0;
  if (afterNum !== null) {
    const idx = items.findIndex((i) => i.number === afterNum);
    start = idx >= 0 ? idx + 1 : items.length;
  }
  const page = first === null ? items.slice(start) : items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length > 0 ? issueCursor(page[page.length - 1].number) : null;
  const startCursor = page.length > 0 ? issueCursor(page[0].number) : null;
  return { page, hasNextPage, endCursor, startCursor };
}

function toIssueObj(repo: Repo, issue: Issue): GqlObj {
  return { __kind: 'Issue', repo, issue };
}

function toPrObj(repo: Repo, pr: PullRequest): GqlObj {
  return { __kind: 'PullRequest', repo, pr };
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

function typeNameOf(obj: GqlObj): string {
  switch (obj.__kind) {
    case 'Query': return 'Query';
    case 'Mutation': return 'Mutation';
    case 'User': return 'User';
    case 'Repository': return 'Repository';
    case 'BranchRef': return 'Ref';
    case 'Issue': return 'Issue';
    case 'PullRequest': return 'PullRequest';
    case 'IssueConnection': return 'IssueConnection';
    case 'PullRequestConnection': return 'PullRequestConnection';
    case 'FileConnection': return 'PullRequestFileConnection';
    case 'IssueEdge': return 'IssueEdge';
    case 'PullRequestEdge': return 'PullRequestEdge';
    case 'FileEdge': return 'PullRequestFileEdge';
    case 'PageInfo': return 'PageInfo';
    case '__Type': return '__Type';
    case 'FieldDef': return '__Field';
    case 'EnumValue': return '__EnumValue';
    case 'Comment': return 'IssueComment';
    case 'CommentEdge': return 'IssueCommentEdge';
    case 'CreateIssuePayload': return 'CreateIssuePayload';
    case 'CloseIssuePayload': return 'CloseIssuePayload';
    case 'CreatePullRequestPayload': return 'CreatePullRequestPayload';
    case 'MergePullRequestPayload': return 'MergePullRequestPayload';
    case 'AddCommentPayload': return 'AddCommentPayload';
  }
}

interface Ctx {
  store: Store;
  vars: Record<string, unknown>;
}

function argStr(args: Record<string, unknown>, name: string): string | null {
  const v = args[name];
  return typeof v === 'string' ? v : null;
}

function argInt(args: Record<string, unknown>, name: string): number | null {
  const v = args[name];
  return typeof v === 'number' ? v : null;
}

function sortedIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  let list = repo.issueOrder.map((n) => repo.issues.get(n)!);
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const dir = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  list.sort((a, b) => (dir === 'DESC' ? b.number - a.number : a.number - b.number));
  return list;
}

function sortedPulls(repo: Repo, args: Record<string, unknown>): PullRequest[] {
  let list = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((p) => wanted.has(p.state));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const dir = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  list.sort((a, b) => (dir === 'DESC' ? b.number - a.number : a.number - b.number));
  return list;
}

function prFiles(repo: Repo, pr: PullRequest): Array<{ path: string }> {
  const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  const headObj = repo.objects.get(headSha);
  const baseObj = repo.objects.get(baseSha);
  if (!headObj || !baseObj) return [];
  const mb = findMergeBase(repo.objects, baseSha, headSha);
  const mbTree = mb ? parseCommit(repo.objects.get(mb)!.data).tree : null;
  const headTree = parseCommit(headObj.data).tree;
  return diffTrees(repo.objects, mbTree, headTree).map((f) => ({ path: f.filename }));
}

function resolveField(ctx: Ctx, obj: GqlObj, field: Extract<SelNode, { kind: 'field' }>): unknown {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) args[k] = resolveVars(v, ctx.vars);
  const name = field.name;
  if (name === '__typename') return typeNameOf(obj);

  switch (obj.__kind) {
    case 'Query': {
      if (name === 'viewer') return { __kind: 'User', login: VIEWER_LOGIN } as GqlObj;
      if (name === 'repository') {
        const owner = argStr(args, 'owner');
        const repoName = argStr(args, 'name');
        if (!owner || !repoName) return null;
        const repo = ctx.store.getRepo(owner, repoName);
        return repo ? ({ __kind: 'Repository', repo } as GqlObj) : null;
      }
      if (name === 'node') {
        const id = argStr(args, 'id');
        if (!id) return null;
        const dec = decodeGlobalId(id);
        if (!dec) return null;
        if (dec.kind === 'Repository') {
          const dbid = parseInt(dec.parts[0], 10);
          const repo = ctx.store.repoList.find((r) => r.databaseId === dbid);
          return repo ? ({ __kind: 'Repository', repo } as GqlObj) : null;
        }
        if (dec.kind === 'Issue') {
          const dbid = parseInt(dec.parts[0], 10);
          const num = parseInt(dec.parts[1], 10);
          const repo = ctx.store.repoList.find((r) => r.databaseId === dbid);
          const issue = repo?.issues.get(num);
          return repo && issue ? toIssueObj(repo, issue) : null;
        }
        if (dec.kind === 'PullRequest') {
          const dbid = parseInt(dec.parts[0], 10);
          const num = parseInt(dec.parts[1], 10);
          const repo = ctx.store.repoList.find((r) => r.databaseId === dbid);
          const pr = repo?.pulls.get(num);
          return repo && pr ? toPrObj(repo, pr) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = argStr(args, 'name');
        if (!typeName || !(typeName in TYPE_KIND)) return null;
        return { __kind: '__Type', name: typeName } as GqlObj;
      }
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
        const dec = decodeGlobalId(repoId);
        const dbid = dec && dec.kind === 'Repository' ? parseInt(dec.parts[0], 10) : NaN;
        const repo = ctx.store.repoList.find((r) => r.databaseId === dbid);
        if (!repo) throw new FieldError('repository not found');
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const { issue, error } = ctx.store.createIssue(repo, title, body, []);
        if (error) throw new FieldError(error);
        return { __kind: 'CreateIssuePayload', issue: issue!, repo } as GqlObj;
      }
      if (name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const issueId = typeof input.issueId === 'string' ? input.issueId : '';
        const dec = decodeGlobalId(issueId);
        const dbid = dec && dec.kind === 'Issue' ? parseInt(dec.parts[0], 10) : NaN;
        const num = dec ? parseInt(dec.parts[1], 10) : NaN;
        const repo = ctx.store.repoList.find((r) => r.databaseId === dbid);
        const issue = repo?.issues.get(num);
        if (!repo || !issue) throw new FieldError('issue not found');
        ctx.store.patchIssue(repo, issue, { state: 'closed' });
        return { __kind: 'CloseIssuePayload', issue, repo } as GqlObj;
      }
      if (name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
        const dec = decodeGlobalId(repoId);
        const dbid = dec && dec.kind === 'Repository' ? parseInt(dec.parts[0], 10) : NaN;
        const repo = ctx.store.repoList.find((r) => r.databaseId === dbid);
        if (!repo) throw new FieldError('repository not found');
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : DEFAULT_BRANCH;
        const { pr, error } = ctx.store.createPull(repo, title, body, head, base);
        if (error) throw new FieldError(error);
        return { __kind: 'CreatePullRequestPayload', pr: pr!, repo } as GqlObj;
      }
      if (name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const prId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
        const dec = decodeGlobalId(prId);
        const dbid = dec && dec.kind === 'PullRequest' ? parseInt(dec.parts[0], 10) : NaN;
        const num = dec ? parseInt(dec.parts[1], 10) : NaN;
        const repo = ctx.store.repoList.find((r) => r.databaseId === dbid);
        const pr = repo?.pulls.get(num);
        if (!repo || !pr) throw new FieldError('pull request not found');
        const result = ctx.store.mergePull(repo, pr);
        if (!result.ok) throw new FieldError(result.message ?? 'merge failed');
        return { __kind: 'MergePullRequestPayload', pr, repo } as GqlObj;
      }
      if (name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
        const dec = decodeGlobalId(subjectId);
        const dbid = dec && dec.kind === 'Issue' ? parseInt(dec.parts[0], 10) : NaN;
        const num = dec ? parseInt(dec.parts[1], 10) : NaN;
        const repo = ctx.store.repoList.find((r) => r.databaseId === dbid);
        const issue = repo?.issues.get(num);
        if (!repo || !issue) throw new FieldError('subject not found');
        const body = typeof input.body === 'string' ? input.body : '';
        const c = ctx.store.createComment(repo, issue, body);
        return {
          __kind: 'AddCommentPayload',
          comment: { __kind: 'Comment', id: commentGlobalId(repo, num, c.id), body: c.body },
        } as GqlObj;
      }
      break;
    }
    case 'User': {
      if (name === 'login') return obj.login;
      if (name === 'id') return VIEWER_ID;
      if (name === 'name') return VIEWER_LOGIN;
      break;
    }
    case 'Repository': {
      const repo = obj.repo;
      if (name === 'id') return repoGlobalId(repo);
      if (name === 'databaseId') return repo.databaseId;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return { __kind: 'User', login: repo.owner } as GqlObj;
      if (name === 'defaultBranchRef') return { __kind: 'BranchRef', name: DEFAULT_BRANCH } as GqlObj;
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'issue') {
        const num = argInt(args, 'number');
        const issue = num !== null ? repo.issues.get(num) : undefined;
        return issue ? toIssueObj(repo, issue) : null;
      }
      if (name === 'issues') {
        return {
          __kind: 'IssueConnection',
          items: sortedIssues(repo, args),
          repo,
          first: argInt(args, 'first'),
          after: argStr(args, 'after'),
        } as GqlObj;
      }
      if (name === 'pullRequest') {
        const num = argInt(args, 'number');
        const pr = num !== null ? repo.pulls.get(num) : undefined;
        return pr ? toPrObj(repo, pr) : null;
      }
      if (name === 'pullRequests') {
        return {
          __kind: 'PullRequestConnection',
          items: sortedPulls(repo, args),
          repo,
          first: argInt(args, 'first'),
          after: argStr(args, 'after'),
        } as GqlObj;
      }
      break;
    }
    case 'BranchRef': {
      if (name === 'name') return obj.name;
      break;
    }
    case 'Issue': {
      const issue = obj.issue;
      if (name === 'id') return issueGlobalId(obj.repo, issue.number);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issue.state.toUpperCase();
      if (name === 'url') return `https://example.invalid/${obj.repo.owner}/${obj.repo.name}/issues/${issue.number}`;
      if (name === 'createdAt' || name === 'updatedAt') return issue.createdAt;
      if (name === 'author') return { __kind: 'User', login: issue.user } as GqlObj;
      break;
    }
    case 'PullRequest': {
      const pr = obj.pr;
      if (name === 'id') return prGlobalId(obj.repo, pr.number);
      if (name === 'number') return pr.number;
      if (name === 'title') return pr.title;
      if (name === 'body') return pr.body;
      if (name === 'state') return pr.state.toUpperCase();
      if (name === 'headRefName') return pr.headRef;
      if (name === 'baseRefName') return pr.baseRef;
      if (name === 'mergeable') return ctx.store.prMergeable(obj.repo, pr);
      if (name === 'merged') return pr.merged;
      if (name === 'url') return `https://example.invalid/${obj.repo.owner}/${obj.repo.name}/pull/${pr.number}`;
      if (name === 'createdAt' || name === 'updatedAt') return pr.createdAt;
      if (name === 'author') return { __kind: 'User', login: VIEWER_LOGIN } as GqlObj;
      if (name === 'files') {
        return { __kind: 'FileConnection', items: prFiles(obj.repo, pr), first: argInt(args, 'first') } as GqlObj;
      }
      break;
    }
    case 'IssueConnection': {
      const { page, hasNextPage, endCursor, startCursor } = connectionPage(obj.items, obj.first, obj.after);
      if (name === 'nodes') return page.map((i) => toIssueObj(obj.repo, i));
      if (name === 'edges') return page.map((i) => ({ __kind: 'IssueEdge', issue: i, repo: obj.repo } as GqlObj));
      if (name === 'pageInfo') return { __kind: 'PageInfo', hasNextPage, endCursor, startCursor } as GqlObj;
      if (name === 'totalCount') return obj.items.length;
      break;
    }
    case 'PullRequestConnection': {
      const { page, hasNextPage, endCursor, startCursor } = connectionPage(obj.items, obj.first, obj.after);
      if (name === 'nodes') return page.map((p) => toPrObj(obj.repo, p));
      if (name === 'edges') return page.map((p) => ({ __kind: 'PullRequestEdge', pr: p, repo: obj.repo } as GqlObj));
      if (name === 'pageInfo') return { __kind: 'PageInfo', hasNextPage, endCursor, startCursor } as GqlObj;
      if (name === 'totalCount') return obj.items.length;
      break;
    }
    case 'FileConnection': {
      const page = obj.first === null ? obj.items : obj.items.slice(0, obj.first);
      if (name === 'nodes') return page.map((f) => ({ __kind: 'FileEdge', path: f.path } as GqlObj));
      if (name === 'edges') return page.map((f) => ({ __kind: 'FileEdge', path: f.path } as GqlObj));
      if (name === 'pageInfo') return { __kind: 'PageInfo', hasNextPage: obj.items.length > page.length, endCursor: null, startCursor: null } as GqlObj;
      if (name === 'totalCount') return obj.items.length;
      break;
    }
    case 'IssueEdge': {
      if (name === 'node') return toIssueObj(obj.repo, obj.issue);
      if (name === 'cursor') return issueCursor(obj.issue.number);
      break;
    }
    case 'PullRequestEdge': {
      if (name === 'node') return toPrObj(obj.repo, obj.pr);
      if (name === 'cursor') return issueCursor(obj.pr.number);
      break;
    }
    case 'FileEdge': {
      if (name === 'path') return obj.path;
      if (name === 'node') return obj;
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return obj.hasNextPage;
      if (name === 'hasPreviousPage') return false;
      if (name === 'endCursor') return obj.endCursor;
      if (name === 'startCursor') return obj.startCursor;
      break;
    }
    case '__Type': {
      if (name === 'name') return obj.name;
      if (name === 'kind') return TYPE_KIND[obj.name] ?? 'OBJECT';
      if (name === 'fields') return (TYPE_FIELDS[obj.name] ?? []).map((n) => ({ __kind: 'FieldDef', name: n } as GqlObj));
      if (name === 'enumValues') {
        if (obj.name !== 'SearchType') return [];
        return ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PROJECT'].map((n) => ({ __kind: 'EnumValue', name: n } as GqlObj));
      }
      break;
    }
    case 'FieldDef':
    case 'EnumValue': {
      if (name === 'name') return obj.name;
      break;
    }
    case 'Comment': {
      if (name === 'id') return obj.id;
      if (name === 'body') return obj.body;
      break;
    }
    case 'CommentEdge': {
      if (name === 'node') return obj.comment;
      if (name === 'cursor') return '';
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (name === 'issue') return obj.issue ? toIssueObj(obj.repo, obj.issue) : null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return obj.pr ? toPrObj(obj.repo, obj.pr) : null;
      break;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') return obj.comment ? ({ __kind: 'CommentEdge', comment: obj.comment } as GqlObj) : null;
      break;
    }
  }
  throw new FieldError(`Cannot query field "${name}" on type "${typeNameOf(obj)}"`);
}

function executeSelection(ctx: Ctx, obj: GqlObj | null, sel: SelNode[], errors: Array<{ message: string }>): Record<string, unknown> | null {
  if (obj === null) return null;
  const out: Record<string, unknown> = {};
  for (const node of sel) {
    if (node.kind === 'fragment') {
      if (node.type !== typeNameOf(obj)) continue;
      const sub = executeSelection(ctx, obj, node.sel, errors);
      if (sub) Object.assign(out, sub);
      continue;
    }
    const key = node.alias;
    try {
      const value = resolveField(ctx, obj, node);
      if (value === null || value === undefined) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        out[key] = value.map((v) => (v !== null && typeof v === 'object' && '__kind' in v ? executeSelection(ctx, v as GqlObj, node.sel, errors) : v));
      } else if (typeof value === 'object' && '__kind' in value) {
        out[key] = node.sel.length > 0 ? executeSelection(ctx, value as GqlObj, node.sel, errors) : value;
      } else {
        out[key] = value;
      }
    } catch (e) {
      errors.push({ message: e instanceof Error ? e.message : String(e) });
      out[key] = null;
    }
  }
  return out;
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  let op: Operation;
  try {
    op = new Parser(query).parseDocument();
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  const errors: Array<{ message: string }> = [];
  const root: GqlObj = op.kind === 'mutation' ? { __kind: 'Mutation' } : { __kind: 'Query' };
  const data = executeSelection({ store, vars: variables }, root, op.sel, errors);
  const out: Record<string, unknown> = { data };
  if (errors.length > 0) out.errors = errors;
  return out;
}

export async function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const auth = req.headers.authorization ?? '';
  if (token === '' || auth !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  const body = parseJsonBody(await readBody(req));
  if (body === undefined) {
    sendJson(res, 400, { errors: [{ message: 'Parse error: invalid JSON' }] });
    return true;
  }
  if (Array.isArray(body)) {
    const results = body.map((item) => {
      const q = item as Record<string, unknown>;
      const query = typeof q.query === 'string' ? q.query : '';
      const vars = (q.variables ?? {}) as Record<string, unknown>;
      return executeGraphQL(store, query, vars);
    });
    sendJson(res, 200, results);
    return true;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { errors: [{ message: 'Parse error: invalid JSON' }] });
    return true;
  }
  const q = body as Record<string, unknown>;
  const query = typeof q.query === 'string' ? q.query : '';
  const vars = (q.variables ?? {}) as Record<string, unknown>;
  sendJson(res, 200, executeGraphQL(store, query, vars));
  return true;
}
