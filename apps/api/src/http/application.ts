import { randomUUID, timingSafeEqual } from 'node:crypto';
import { DomainError, objectInput, onlyFields } from '../domain/errors.ts';
import type { BookingService } from '../domain/booking-service.ts';

export const MAX_BODY_BYTES = 16_384;

function jsonResponse(data: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify({ data, requestId }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      'x-content-type-options': 'nosniff',
    },
  });
}

export function errorResponse(error: unknown, requestId: string): Response {
  const known = error instanceof DomainError;
  const response = jsonResponse(null, requestId, known ? error.status : 500);
  return new Response(JSON.stringify({
    code: known ? error.code : 'INTERNAL_ERROR',
    message: known ? error.message : 'An internal error occurred',
    requestId,
  }), { status: response.status, headers: response.headers });
}

async function body(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Use application/json', 415);
  }
  if (request.headers.has('content-encoding')) {
    throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Encoded request bodies are not supported', 415);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new DomainError('PAYLOAD_TOO_LARGE', 'Request body is too large', 413);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new DomainError('INVALID_JSON', 'Request body must be valid UTF-8 JSON', 400);
  }
}

function authenticate(request: Request, token: string, userId: string): string {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new DomainError('UNAUTHORIZED', 'A valid development bearer token is required', 401);
  }
  return userId;
}

export function createApplication(service: BookingService, options: { token: string; userId: string }) {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === 'GET' && path === '/health') {
        return jsonResponse({ status: 'ok', environment: 'development-only', storage: 'volatile-memory',
          authentication: 'development-token', paymentsEnabled: false }, requestId);
      }
      if (request.method === 'GET' && path === '/api/v1/services') {
        return jsonResponse(await service.listServices(), requestId);
      }
      if (request.method === 'GET' && path === '/api/v1/slots') {
        return jsonResponse(await service.listSlots(url.searchParams.get('serviceId') ?? '',
          url.searchParams.get('areaId') ?? ''), requestId);
      }
      const userId = authenticate(request, options.token, options.userId);
      if (request.method === 'GET' && path === '/api/v1/pets') {
        return jsonResponse(await service.listPets(userId), requestId);
      }
      if (request.method === 'GET' && path === '/api/v1/addresses') {
        return jsonResponse(await service.listAddresses(userId), requestId);
      }
      if (request.method === 'POST' && path === '/api/v1/orders/quotes') {
        return jsonResponse(await service.createQuote(userId, await body(request)), requestId, 201);
      }
      if (request.method === 'POST' && path === '/api/v1/orders') {
        return jsonResponse(await service.createOrder(userId, await body(request),
          request.headers.get('idempotency-key'), requestId), requestId, 201);
      }
      if (request.method === 'GET' && path === '/api/v1/orders') {
        const limit = url.searchParams.get('limit');
        return jsonResponse(await service.listOrders(userId, limit === null ? 20 : Number(limit),
          url.searchParams.get('cursor') ?? undefined), requestId);
      }
      const cancelMatch = /^\/api\/v1\/orders\/([a-zA-Z0-9_-]+)\/cancel-requests$/.exec(path);
      if (request.method === 'POST' && cancelMatch?.[1]) {
        const input = objectInput(await body(request));
        onlyFields(input, []);
        return jsonResponse(await service.cancelUnsubmittedOrder(userId, cancelMatch[1],
          request.headers.get('idempotency-key'), requestId), requestId);
      }
      const orderMatch = /^\/api\/v1\/orders\/([a-zA-Z0-9_-]+)$/.exec(path);
      if (request.method === 'GET' && orderMatch?.[1]) {
        return jsonResponse(await service.getOrder(userId, orderMatch[1]), requestId);
      }
      if (path.startsWith('/api/v1/webhooks/') || /\/prepayments$/.test(path)) {
        throw new DomainError('PAYMENTS_NOT_IMPLEMENTED', 'Payment integration is not implemented', 501);
      }
      throw new DomainError('NOT_FOUND', 'Resource not found', 404);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}
