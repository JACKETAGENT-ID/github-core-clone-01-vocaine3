// MCP endpoint (POST /mcp): JSON-RPC 2.0, MCP 2026-07-28 `server/discover` + legacy
// `initialize`, six GitHub tools over the same in-memory store as REST.
// Node 24 stdlib only.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_BRANCH, VIEWER_LOGIN, prJson, repoJson } from './store.ts';
import type { Store } from './store.ts';
import { parseJsonBody, readBody, sendJson, sendText } from './httputil.ts';

const SERVER_NAME = 'forge-v3';
const SERVER_VERSION = '1.0.0';
const REVISIONS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// Serialized once: tools/list must be byte-identical across calls.
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function toolOk(obj: unknown): ToolResult {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolErr(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(tool: string, arg: string): ToolResult {
  return toolErr(`${tool}: missing required argument "${arg}"`);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name.trim() : '';
      if (repoName === '') return missingArg(name, 'name');
      if (store.getRepo(VIEWER_LOGIN, repoName)) return toolErr(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
      const repo = store.createRepo(
        VIEWER_LOGIN,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      if (owner === '') return missingArg(name, 'owner');
      if (repoName === '') return missingArg(name, 'repo');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErr(`Repository ${owner}/${repoName} not found`);
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      const title = typeof args.title === 'string' ? args.title : '';
      if (owner === '') return missingArg(name, 'owner');
      if (repoName === '') return missingArg(name, 'repo');
      if (title === '') return missingArg(name, 'title');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErr(`Repository ${owner}/${repoName} not found`);
      const { issue, error } = store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      if (error) return toolErr(error);
      return toolOk({
        id: issue!.id,
        number: issue!.number,
        title: issue!.title,
        body: issue!.body,
        state: issue!.state,
        html_url: `https://example.invalid/${owner}/${repoName}/issues/${issue!.number}`,
      });
    }
    case 'list_issues': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      if (owner === '') return missingArg(name, 'owner');
      if (repoName === '') return missingArg(name, 'repo');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErr(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = repo.issueOrder.map((n) => repo.issues.get(n)!);
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const items = list.map((i) => ({
        id: i.id,
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
      }));
      return toolOk({ issues: items });
    }
    case 'create_pull_request': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (owner === '') return missingArg(name, 'owner');
      if (repoName === '') return missingArg(name, 'repo');
      if (title === '') return missingArg(name, 'title');
      if (head === '') return missingArg(name, 'head');
      if (base === '') return missingArg(name, 'base');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErr(`Repository ${owner}/${repoName} not found`);
      const { pr, error } = store.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      if (error) return toolErr(error);
      return toolOk(prJson(repo, pr!));
    }
    case 'merge_pull_request': {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : '';
      const num = typeof args.pull_number === 'number' ? args.pull_number : NaN;
      if (owner === '') return missingArg(name, 'owner');
      if (repoName === '') return missingArg(name, 'repo');
      if (Number.isNaN(num)) return missingArg(name, 'pull_number');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolErr(`Repository ${owner}/${repoName} not found`);
      const pr = repo.pulls.get(num);
      if (!pr) return toolErr(`Pull request #${num} not found`);
      const result = store.mergePull(repo, pr);
      if (!result.ok) return toolErr(result.message ?? 'Merge failed');
      return toolOk({ merged: true, sha: result.sha, message: result.message, number: pr.number, state: pr.state });
    }
    default:
      return toolErr(`Unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const auth = req.headers.authorization ?? '';
  if (token === '' || auth !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  const raw = await readBody(req);
  const body = parseJsonBody(raw);
  if (body === undefined) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const msg = body as Record<string, unknown>;
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (msg.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get no JSON-RPC reply (202 empty).
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      resultType: 'discover',
      supportedVersions: REVISIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    }));
    return true;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : REVISIONS[0];
    const version = REVISIONS.includes(requested) ? requested : REVISIONS[0];
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return true;
  }

  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return true;
  }

  if (method === 'tools/list') {
    // Byte-identical across calls (pre-serialized payload).
    sendText(res, 200, JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: JSON.parse(TOOLS_LIST_JSON) }), 'application/json');
    return true;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!TOOLS.some((t) => t.name === toolName)) {
      sendJson(res, 200, rpcError(id, -32601, `Unknown tool: ${toolName}`));
      return true;
    }
    const result = callTool(store, toolName, args);
    sendJson(res, 200, rpcResult(id, result));
    return true;
  }

  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}
