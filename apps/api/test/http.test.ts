import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApplication, MAX_BODY_BYTES } from '../src/http/application.ts';
import { BookingService } from '../src/domain/booking-service.ts';
import { ProfileService } from '../src/domain/profile-service.ts';
import { MemoryBookingStore } from '../src/storage/memory-store.ts';
import { demoState } from '../src/development/demo-data.ts';
import { loadConfig } from '../src/config.ts';
import type { Address, Order, Pet, Quote, Service } from '../src/domain/models.ts';

async function responseBody<Data>(response: Response): Promise<{ data: Data; requestId: string }> {
  return await response.json() as { data: Data; requestId: string };
}

async function responseError(response: Response): Promise<{ code: string; message: string; requestId: string }> {
  return await response.json() as { code: string; message: string; requestId: string };
}

const token = 'development-test-token-not-for-production';

function fixture() {
  const now = new Date('2026-10-21T07:00:00.000Z');
  const state = demoState('user-one', now);
  state.pets.set('other-cat', { id: 'other-cat', userId: 'user-two', name: 'Other', type: 'CAT', careNotes: '' });
  state.addresses.set('other-address', { id: 'other-address', userId: 'user-two', areaId: 'demo-area', label: 'Other' });
  const store = new MemoryBookingStore(state);
  const service = new BookingService(store, { clock: () => now });
  const application = createApplication(service, new ProfileService(store), { token, userId: 'user-one' });
  return async (path: string, options: { method?: string; body?: string; authorized?: boolean;
    key?: string; contentType?: string; extraHeaders?: Record<string, string> } = {}) => application(new Request(`http://localhost${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.authorized === false ? {} : { authorization: `Bearer ${token}` }),
      ...(options.body === undefined ? {} : { 'content-type': options.contentType ?? 'application/json' }),
      ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
      ...options.extraHeaders,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  }));
}

describe('development HTTP contract', () => {
  it('exposes honest health and public catalogue without authentication', async () => {
    const request = fixture();
    const health = await request('/health', { authorized: false });
    assert.equal(health.status, 200);
    assert.equal((await responseBody<{ paymentsEnabled: boolean }>(health)).data.paymentsEnabled, false);
    const services = await request('/api/v1/services', { authorized: false });
    assert.equal((await responseBody<Service[]>(services)).data[0]?.basePriceFen, 5000);
    assert.equal(services.headers.get('cache-control'), 'no-store');
    const slots = await request('/api/v1/slots?serviceId=demo-cat-care&areaId=demo-area', { authorized: false });
    assert.equal((await responseBody<Array<{ available: number }>>(slots)).data[0]?.available, 1);
  });

  it('does not allow caller headers to impersonate a user', async () => {
    const response = await fixture()('/api/v1/pets', { authorized: false, extraHeaders: { 'x-user-id': 'user-one' } });
    assert.equal(response.status, 401);
    assert.equal((await responseError(response)).code, 'UNAUTHORIZED');
  });

  it('runs quote → order → owned detail → cancellation and releases capacity', async () => {
    const request = fixture();
    const quoteResponse = await request('/api/v1/orders/quotes', { method: 'POST', body: JSON.stringify({
      serviceId: 'demo-cat-care', slotId: 'demo-slot', addressId: 'demo-address', petIds: ['demo-cat'],
    }) });
    assert.equal(quoteResponse.status, 201);
    const quote = (await responseBody<Quote>(quoteResponse)).data;
    const createOptions = { method: 'POST', body: JSON.stringify({ quoteId: quote.id }), key: 'http-create-key' };
    const response = await request('/api/v1/orders', createOptions);
    assert.equal(response.status, 201);
    const created = await responseBody<Order>(response);
    assert.equal(created.data.amountFen, 5000);
    assert.equal(created.data.paymentStatus, 'UNPAID');
    assert.equal(response.headers.get('x-request-id'), created.requestId);
    assert.equal((await responseBody<Order>(await request('/api/v1/orders', createOptions))).data.id, created.data.id);
    assert.equal((await responseBody<Order>(await request(`/api/v1/orders/${created.data.id}`))).data.status, 'PENDING_PAYMENT');
    assert.equal((await responseBody<{ items: Order[] }>(await request('/api/v1/orders'))).data.items.length, 1);
    const cancelled = await request(`/api/v1/orders/${created.data.id}/cancel-requests`, {
      method: 'POST', body: '{}', key: 'http-cancel-key',
    });
    assert.equal((await responseBody<Order>(cancelled)).data.status, 'CANCELLED');
    assert.equal((await responseBody<Array<{ available: number }>>(await request('/api/v1/slots?serviceId=demo-cat-care&areaId=demo-area'))).data[0]?.available, 1);
  });

  it('rejects malformed JSON, wrong content types and oversized requests', async () => {
    const request = fixture();
    const malformed = await request('/api/v1/orders/quotes', { method: 'POST', body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await responseError(malformed)).code, 'INVALID_JSON');
    const wrongType = await request('/api/v1/orders/quotes', { method: 'POST', body: '{}', contentType: 'text/plain' });
    assert.equal(wrongType.status, 415);
    const oversized = await request('/api/v1/orders/quotes', { method: 'POST', body: ' '.repeat(MAX_BODY_BYTES + 1) });
    assert.equal(oversized.status, 413);
  });

  it('requires idempotency keys and refuses unimplemented payments', async () => {
    const request = fixture();
    const response = await request('/api/v1/orders', { method: 'POST', body: JSON.stringify({ quoteId: 'valid-quote' }) });
    assert.equal(response.status, 400);
    const payment = await request('/api/v1/orders/example/prepayments', { method: 'POST', body: '{}' });
    assert.equal(payment.status, 501);
    assert.equal((await responseError(payment)).code, 'PAYMENTS_NOT_IMPLEMENTED');
  });

  it('returns normalized errors and does not reflect a caller supplied request ID', async () => {
    const response = await fixture()('/api/v1/orders/nonexistent', { extraHeaders: { 'x-request-id': 'attacker-input' } });
    assert.equal(response.status, 404);
    const error = await responseError(response);
    assert.equal(error.code, 'NOT_FOUND');
    assert.notEqual(error.requestId, 'attacker-input');
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'requestId']);
  });
});

describe('profile HTTP contract', () => {
  it('creates and maintains profiles through authenticated endpoints', async () => {
    const request = fixture();
    const createdPet = await request('/api/v1/pets', {
      method: 'POST', body: JSON.stringify({ name: '测试猫咪', type: 'CAT' }),
    });
    assert.equal(createdPet.status, 201);
    const pet = (await responseBody<Pet>(createdPet)).data;
    assert.equal(pet.userId, 'user-one');
    const updatedPet = await request(`/api/v1/pets/${pet.id}`, {
      method: 'PATCH', body: JSON.stringify({ careNotes: '请换水' }),
    });
    assert.equal(updatedPet.status, 200);
    assert.equal((await responseBody<Pet>(updatedPet)).data.careNotes, '请换水');
    assert.equal((await responseBody<Pet>(await request(`/api/v1/pets/${pet.id}`))).data.name, '测试猫咪');
    assert.equal((await responseBody<Pet[]>(await request('/api/v1/pets'))).data.length, 2);
    const createdAddress = await request('/api/v1/addresses', {
      method: 'POST', body: JSON.stringify({ areaId: 'demo-area', label: '测试地址' }),
    });
    assert.equal(createdAddress.status, 201);
    const address = (await responseBody<Address>(createdAddress)).data;
    const updatedAddress = await request(`/api/v1/addresses/${address.id}`, {
      method: 'PATCH', body: JSON.stringify({ label: '新测试地址' }),
    });
    assert.equal(updatedAddress.status, 200);
    assert.equal((await responseBody<Address>(await request(`/api/v1/addresses/${address.id}`))).data.label, '新测试地址');
    assert.equal((await responseBody<Address[]>(await request('/api/v1/addresses'))).data.length, 2);
    for (const path of [`/api/v1/pets/${pet.id}`, `/api/v1/addresses/${address.id}`]) {
      const deleted = await request(path, { method: 'DELETE' });
      assert.equal(deleted.status, 200);
      assert.equal((await responseBody<{ deleted: boolean }>(deleted)).data.deleted, true);
      assert.equal((await request(path)).status, 404);
    }
  });

  it('requires authentication for every profile operation and rejects forged ownership', async () => {
    const request = fixture();
    for (const collection of ['pets', 'addresses']) {
      for (const method of ['GET', 'POST']) {
        assert.equal((await request(`/api/v1/${collection}`, { method, authorized: false })).status, 401);
      }
      for (const method of ['GET', 'PATCH', 'DELETE']) {
        assert.equal((await request(`/api/v1/${collection}/unknown`, { method, authorized: false })).status, 401);
      }
    }
    const forged = await request('/api/v1/pets', {
      method: 'POST', body: JSON.stringify({ name: '测试', type: 'CAT', userId: 'user-two' }),
    });
    assert.equal(forged.status, 400);
    assert.equal((await responseError(forged)).code, 'INVALID_REQUEST');
    const created = await request('/api/v1/pets', { method: 'POST', body: JSON.stringify({ name: '测试', type: 'CAT' }),
      extraHeaders: { 'x-user-id': 'user-two' } });
    assert.equal((await responseBody<Pet>(created)).data.userId, 'user-one');
  });

  it('returns 404 for foreign profile detail, edits and deletion without exposing ownership', async () => {
    const request = fixture();
    for (const [path, changes] of [
      ['/api/v1/pets/other-cat', { name: 'stolen' }],
      ['/api/v1/addresses/other-address', { label: 'stolen' }],
    ] as const) {
      for (const method of ['GET', 'PATCH', 'DELETE']) {
        const response = await request(path, { method,
          ...(method === 'PATCH' ? { body: JSON.stringify(changes) } : {}) });
        assert.equal(response.status, 404);
        assert.equal((await responseError(response)).code, 'NOT_FOUND');
      }
    }
  });

  it('enforces body validation and configured areas for profile writes', async () => {
    const request = fixture();
    const malformed = await request('/api/v1/pets', { method: 'POST', body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await responseError(malformed)).code, 'INVALID_JSON');
    const unknownArea = await request('/api/v1/addresses', {
      method: 'POST', body: JSON.stringify({ areaId: 'unknown-area', label: '测试' }),
    });
    assert.equal(unknownArea.status, 409);
    assert.equal((await responseError(unknownArea)).code, 'AREA_UNAVAILABLE');
    assert.equal((await request('/api/v1/addresses/demo-address', { method: 'PATCH', body: '{}' })).status, 400);
    assert.equal((await request('/api/v1/pets/demo-cat', {
      method: 'PATCH', body: '{}', contentType: 'text/plain',
    })).status, 415);
    assert.equal((await request('/api/v1/pets', {
      method: 'POST', body: ' '.repeat(MAX_BODY_BYTES + 1),
    })).status, 413);
  });

  it('connects profile creation to quotes and orders, rejects stale quotes and protects active references', async () => {
    const request = fixture();
    const pet = (await responseBody<Pet>(await request('/api/v1/pets', {
      method: 'POST', body: JSON.stringify({ name: '新猫咪', type: 'CAT' }),
    }))).data;
    const address = (await responseBody<Address>(await request('/api/v1/addresses', {
      method: 'POST', body: JSON.stringify({ areaId: 'demo-area', label: '测试地址' }),
    }))).data;
    const input = { serviceId: 'demo-cat-care', slotId: 'demo-slot', addressId: address.id, petIds: [pet.id] };
    const first = (await responseBody<Quote>(await request('/api/v1/orders/quotes', {
      method: 'POST', body: JSON.stringify(input),
    }))).data;
    await request(`/api/v1/pets/${pet.id}`, { method: 'PATCH', body: JSON.stringify({ careNotes: '新的照护说明' }) });
    const stale = await request('/api/v1/orders', {
      method: 'POST', body: JSON.stringify({ quoteId: first.id }), key: 'http-stale-profile',
    });
    assert.equal(stale.status, 409);
    assert.equal((await responseError(stale)).code, 'QUOTE_STALE');
    const fresh = (await responseBody<Quote>(await request('/api/v1/orders/quotes', {
      method: 'POST', body: JSON.stringify(input),
    }))).data;
    const created = await request('/api/v1/orders', {
      method: 'POST', body: JSON.stringify({ quoteId: fresh.id }), key: 'http-fresh-profile',
    });
    assert.equal(created.status, 201);
    const order = (await responseBody<Order>(created)).data;
    for (const path of [`/api/v1/pets/${pet.id}`, `/api/v1/addresses/${address.id}`]) {
      const deletion = await request(path, { method: 'DELETE' });
      assert.equal(deletion.status, 409);
      assert.equal((await responseError(deletion)).code, 'RESOURCE_IN_USE');
    }
    await request(`/api/v1/orders/${order.id}/cancel-requests`, { method: 'POST', body: '{}', key: 'http-profile-cancel' });
    assert.equal((await request(`/api/v1/pets/${pet.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await request(`/api/v1/addresses/${address.id}`, { method: 'DELETE' })).status, 200);
    const retained = (await responseBody<Order>(await request(`/api/v1/orders/${order.id}`))).data;
    assert.equal(retained.snapshot.petSnapshots[0]?.careNotes, '新的照护说明');
    assert.equal(retained.snapshot.addressSnapshot.label, '测试地址');
  });
});

describe('startup guards', () => {
  const environment = {
    NODE_ENV: 'development', PETPAL_STORAGE: 'memory', PETPAL_AUTH: 'development', PETPAL_DEV_TOKEN: token,
  };

  it('requires explicit development mode and adequate credentials', () => {
    assert.equal(loadConfig(environment).demoData, false);
    assert.equal(loadConfig(environment).host, '127.0.0.1');
    assert.throws(() => loadConfig({ ...environment, NODE_ENV: 'production' }), /cannot start/);
    assert.throws(() => loadConfig({ ...environment, PETPAL_DEV_TOKEN: '' }), /PETPAL_DEV_TOKEN/);
    assert.throws(() => loadConfig({ ...environment, PETPAL_AUTH: 'wechat' }), /explicitly enabled/);
    assert.throws(() => loadConfig({ ...environment, PETPAL_STORAGE: 'mysql' }), /MYSQL_USER/);
    const mysql = loadConfig({ ...environment, PETPAL_STORAGE: 'mysql', MYSQL_USER: 'developer',
      MYSQL_PASSWORD: 'local-secret', MYSQL_DATABASE: 'petpal_dev' });
    assert.equal(mysql.storage, 'mysql');
    assert.equal(mysql.mysql?.database, 'petpal_dev');
  });

  it('refuses public binding and invalid configuration values', () => {
    assert.throws(() => loadConfig({ ...environment, HOST: '0.0.0.0' }), /loopback/);
    assert.throws(() => loadConfig({ ...environment, PORT: 'NaN' }), /PORT/);
    assert.throws(() => loadConfig({ ...environment, PORT: '0' }), /PORT/);
    assert.throws(() => loadConfig({ ...environment, PETPAL_ENABLE_DEMO_DATA: 'yes' }), /true or false/);
    assert.throws(() => loadConfig({ ...environment, PETPAL_STORAGE: 'redis' }), /explicitly enabled/);
    assert.throws(() => loadConfig({ ...environment, PETPAL_STORAGE: 'mysql', MYSQL_USER: 'developer',
      MYSQL_PASSWORD: 'local-secret', MYSQL_HOST: 'database.example.com' }), /loopback MYSQL_HOST/);
  });
});
