import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { DomainError } from '../domain/errors.ts';
import { errorResponse, MAX_BODY_BYTES } from './application.ts';

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new DomainError('PAYLOAD_TOO_LARGE', 'Request body is too large', 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function createApiServer(application: (request: Request) => Promise<Response>) {
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8_192 }, async (incoming, outgoing) => {
    let response: Response;
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) headers.set(name, value.join(', '));
        else if (value !== undefined) headers.set(name, value);
      }
      const payload = await readBody(incoming);
      const request = new Request(new URL(incoming.url ?? '/', 'http://localhost'), {
        method: incoming.method ?? 'GET', headers,
        ...(payload === undefined ? {} : { body: new Uint8Array(payload) }),
      });
      response = await application(request);
    } catch (error) {
      response = errorResponse(error, randomUUID());
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
}
