// Forge v3 HTTP server: routes /healthz, /meta, REST v3, GraphQL, MCP and git smart HTTP
// onto one in-memory store. Node 24 stdlib only; no external service, no git binary.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import type { Repo } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertiseReceive,
  advertiseV0,
  advertiseV2,
  handleReceivePack,
  handleUploadPackV0,
  handleUploadPackV2,
} from './gitproto.ts';
import { nextRequestId, readBody, sendBuffer, sendJson } from './httputil.ts';

async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<boolean> {
  const segs = pathname.split('/').filter((s) => s.length > 0);
  if (segs.length < 3) return false;
  const repoSeg = segs[1];
  if (!repoSeg.endsWith('.git')) return false;
  const owner = decodeURIComponent(segs[0]);
  const repoName = decodeURIComponent(repoSeg.slice(0, -4));
  const repo: Repo | undefined = store.getRepo(owner, repoName);

  // GET /<owner>/<repo>.git/info/refs?service=git-upload-pack|git-receive-pack
  if (segs[2] === 'info' && segs[3] === 'refs') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { message: 'Method not allowed' });
      return true;
    }
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      sendBuffer(res, 200, v2 ? advertiseV2() : advertiseV0(repo), 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, advertiseReceive(repo), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // POST /<owner>/<repo>.git/git-upload-pack
  if (segs[2] === 'git-upload-pack' && req.method === 'POST') {
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const body = await readBody(req);
    const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    try {
      const out = v2 ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
      sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
    } catch (e) {
      sendJson(res, 400, { message: e instanceof Error ? e.message : 'bad fetch request' });
    }
    return true;
  }

  // POST /<owner>/<repo>.git/git-receive-pack
  if (segs[2] === 'git-receive-pack' && req.method === 'POST') {
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const body = await readBody(req);
    const result = handleReceivePack(repo, body);
    if (result.status !== 200) {
      sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
      return true;
    }
    sendBuffer(res, 200, result.body, 'application/x-git-receive-pack-result');
    return true;
  }

  return false;
}

export function createApp() {
  const store = new Store();
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        const pathname = url.pathname;
        const query = url.searchParams;
        const method = req.method ?? 'GET';

        if (pathname === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true }, { 'X-GitHub-Request-Id': nextRequestId() });
          return;
        }
        if ((pathname === '/meta' || pathname === '/api/v3/meta') && method === 'GET') {
          sendJson(res, 200, { installed_version: '1.0.0-forge-v3' }, { 'X-GitHub-Request-Id': nextRequestId() });
          return;
        }
        if ((pathname === '/' || pathname === '/api/v3' || pathname === '/api/v3/') && method === 'GET') {
          sendJson(res, 200, {}, { 'X-OAuth-Scopes': 'repo, read:org', 'X-GitHub-Request-Id': nextRequestId() });
          return;
        }
        if (pathname === '/api/graphql' && method === 'POST') {
          await handleGraphQL(store, req, res);
          return;
        }
        if (pathname === '/mcp' && method === 'POST') {
          await handleMcp(store, req, res);
          return;
        }
        if (pathname.startsWith('/api/v3')) {
          await handleRest(store, req, res, pathname, query);
          return;
        }
        if (await handleGit(store, req, res, pathname, query)) return;
        sendJson(res, 404, { message: 'Not Found' });
      } catch (e) {
        // A bad request must never kill the server.
        try {
          if (!res.headersSent) sendJson(res, 500, { message: e instanceof Error ? e.message : 'internal error' });
          else res.end();
        } catch {
          // Nothing left to do.
        }
      }
    })();
  });
  return server;
}
