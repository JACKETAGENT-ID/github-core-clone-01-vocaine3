// Shared HTTP helpers for the forge server. Node 24 stdlib only.
import type { IncomingMessage, ServerResponse } from 'node:http';

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, obj: unknown, extra?: Record<string, string>): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(extra ?? {}) });
  res.end(body);
}

export function sendText(res: ServerResponse, status: number, text: string, contentType = 'application/json', extra?: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(text), ...(extra ?? {}) });
  res.end(text);
}

export function sendBuffer(res: ServerResponse, status: number, buf: Buffer, contentType: string, extra?: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': buf.length, ...(extra ?? {}) });
  res.end(buf);
}

export function errJson(res: ServerResponse, status: number, message: string, extra?: Record<string, string>): void {
  sendJson(res, status, { message }, extra);
}

/** Parse a JSON body leniently; returns null on empty or malformed input. */
export function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

let reqCounter = 0;
export function nextRequestId(): string {
  reqCounter = (reqCounter + 1) >>> 0;
  return String(reqCounter);
}

export function b64encode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

export function b64decode(s: string): string {
  return Buffer.from(s, 'base64').toString('utf8');
}
