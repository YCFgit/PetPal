import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BookingService } from '../src/domain/booking-service.ts';
import { ProfileService } from '../src/domain/profile-service.ts';
import { DomainError } from '../src/domain/errors.ts';
import { demoState } from '../src/development/demo-data.ts';
import { MemoryBookingStore } from '../src/storage/memory-store.ts';

const booking = { serviceId: 'demo-cat-care', slotId: 'demo-slot', addressId: 'demo-address', petIds: ['demo-cat'] };

function fixture() {
  const now = new Date('2026-10-21T07:00:00.000Z');
  const store = new MemoryBookingStore(demoState('user-one', now));
  return { store, profiles: new ProfileService(store), bookings: new BookingService(store, { clock: () => now }) };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

describe('owned profile maintenance', () => {
  it('creates, reads, partially updates and deletes a pet with a server-owned identity', async () => {
    const { profiles } = fixture();
    const pet = await profiles.createPet('user-one', { name: '  咪咪  ', type: 'CAT' });
    assert.notEqual(pet.id, 'demo-cat');
    assert.equal(pet.userId, 'user-one');
    assert.equal(pet.name, '咪咪');
    assert.equal(pet.careNotes, '');
    assert.deepEqual(await profiles.getPet('user-one', pet.id), pet);
    const updated = await profiles.updatePet('user-one', pet.id, { careNotes: ' 每次半勺\n请换水 ' });
    assert.equal(updated.name, '咪咪');
    assert.equal(updated.careNotes, '每次半勺\n请换水');
    updated.name = 'caller mutation';
    assert.equal((await profiles.getPet('user-one', pet.id)).name, '咪咪');
    assert.equal((await profiles.listPets('user-one')).length, 2);
    assert.deepEqual(await profiles.deletePet('user-one', pet.id), { id: pet.id, deleted: true });
    await assert.rejects(profiles.getPet('user-one', pet.id), hasCode('NOT_FOUND'));
  });

  it('creates and maintains an address only within a configured service area', async () => {
    const { profiles } = fixture();
    const address = await profiles.createAddress('user-one', { areaId: 'demo-area', label: ' 测试地址 ' });
    assert.equal(address.userId, 'user-one');
    assert.equal(address.label, '测试地址');
    assert.equal((await profiles.listAddresses('user-one')).length, 2);
    const updated = await profiles.updateAddress('user-one', address.id, { label: '新测试地址' });
    assert.equal(updated.areaId, 'demo-area');
    updated.label = 'caller mutation';
    assert.equal((await profiles.getAddress('user-one', address.id)).label, '新测试地址');
    await assert.rejects(profiles.updateAddress('user-one', address.id, { areaId: 'unknown-area' }), hasCode('AREA_UNAVAILABLE'));
    assert.equal((await profiles.getAddress('user-one', address.id)).areaId, 'demo-area');
    await profiles.deleteAddress('user-one', address.id);
    await assert.rejects(profiles.getAddress('user-one', address.id), hasCode('NOT_FOUND'));
  });

  it('hides foreign profiles for reads, changes, deletion and lists', async () => {
    const { profiles } = fixture();
    assert.deepEqual(await profiles.listPets('user-two'), []);
    assert.deepEqual(await profiles.listAddresses('user-two'), []);
    for (const operation of [
      () => profiles.getPet('user-two', 'demo-cat'),
      () => profiles.updatePet('user-two', 'demo-cat', { name: 'stolen' }),
      () => profiles.deletePet('user-two', 'demo-cat'),
      () => profiles.getAddress('user-two', 'demo-address'),
      () => profiles.updateAddress('user-two', 'demo-address', { label: 'stolen' }),
      () => profiles.deleteAddress('user-two', 'demo-address'),
    ]) await assert.rejects(operation(), hasCode('NOT_FOUND'));
    assert.equal((await profiles.getPet('user-one', 'demo-cat')).name, '示例猫咪');
    assert.equal((await profiles.getAddress('user-one', 'demo-address')).areaId, 'demo-area');
  });

  it('rejects missing, oversized, malformed and client-controlled pet fields', () => {
    const { profiles } = fixture();
    for (const input of [null, [], {}, { name: '猫', type: 'BIRD' }, { name: '  ', type: 'CAT' },
      { name: '猫'.repeat(81), type: 'CAT' }, { name: '猫\n咪', type: 'CAT' },
      { name: '猫', type: 'CAT', careNotes: null }, { name: '猫', type: 'CAT', careNotes: 'a'.repeat(2001) },
      { name: '猫', type: 'CAT', careNotes: 'a\u0000b' },
      { name: '猫', type: 'CAT', userId: 'user-two' }, { name: '猫', type: 'CAT', id: 'my-id' }]) {
      assert.throws(() => profiles.createPet('user-one', input), hasCode('INVALID_REQUEST'));
    }
    for (const input of [{}, { name: null }, { careNotes: 123 }, { type: '' }, { userId: 'user-two' }]) {
      assert.throws(() => profiles.updatePet('user-one', 'demo-cat', input), hasCode('INVALID_REQUEST'));
    }
  });

  it('rejects address ownership, credentials and invalid labels or area identifiers', async () => {
    const { profiles } = fixture();
    for (const input of [null, [], {}, { areaId: 'demo-area', label: ' ' },
      { areaId: 'demo-area', label: 'x'.repeat(201) }, { areaId: '../area', label: '测试' },
      { areaId: 'demo-area', label: '测试', userId: 'user-two' },
      { areaId: 'demo-area', label: '测试', doorCode: '1234' }]) {
      assert.throws(() => profiles.createAddress('user-one', input), hasCode('INVALID_REQUEST'));
    }
    assert.throws(() => profiles.updateAddress('user-one', 'demo-address', {}), hasCode('INVALID_REQUEST'));
    await assert.rejects(profiles.createAddress('user-one', { areaId: 'unknown', label: '测试' }), hasCode('AREA_UNAVAILABLE'));
  });

  it('rejects an area when its slots or services are inactive', async () => {
    const { profiles, store } = fixture();
    const address = { areaId: 'demo-area', label: '测试' };
    await store.transaction(state => { state.slots.get('demo-slot')!.active = false; });
    await assert.rejects(profiles.createAddress('user-one', address), hasCode('AREA_UNAVAILABLE'));
    await store.transaction(state => {
      state.slots.get('demo-slot')!.active = true;
      state.services.get('demo-cat-care')!.active = false;
    });
    await assert.rejects(profiles.createAddress('user-one', address), hasCode('AREA_UNAVAILABLE'));
  });
});

describe('profile changes and booking snapshots', () => {
  it('books using newly created profiles', async () => {
    const { profiles, bookings } = fixture();
    const pet = await profiles.createPet('user-one', { name: '新猫咪', type: 'CAT', careNotes: '请换水' });
    const address = await profiles.createAddress('user-one', { areaId: 'demo-area', label: '新测试地址' });
    const quote = await bookings.createQuote('user-one', { ...booking, addressId: address.id, petIds: [pet.id] });
    const order = await bookings.createOrder('user-one', { quoteId: quote.id }, 'new-profiles-key', 'request-one');
    assert.equal(order.snapshot.petSnapshots[0]?.name, '新猫咪');
    assert.equal(order.snapshot.addressSnapshot.label, '新测试地址');
  });

  it('rejects old quotes for every editable pet field without reserving capacity', async () => {
    for (const changes of [{ name: '改名' }, { type: 'DOG' }, { careNotes: '新的说明' }]) {
      const { profiles, bookings, store } = fixture();
      const quote = await bookings.createQuote('user-one', booking);
      await profiles.updatePet('user-one', 'demo-cat', changes);
      await assert.rejects(bookings.createOrder('user-one', { quoteId: quote.id }, 'changed-pet-key', 'request-one'),
        hasCode('QUOTE_STALE'));
      assert.equal(await store.transaction(state => state.slots.get('demo-slot')?.reserved), 0);
    }
  });

  it('rejects quotes after address edits and accepts a fresh quote', async () => {
    const { profiles, bookings } = fixture();
    const quote = await bookings.createQuote('user-one', booking);
    await profiles.updateAddress('user-one', 'demo-address', { label: '修改后测试地址' });
    await assert.rejects(bookings.createOrder('user-one', { quoteId: quote.id }, 'changed-address-key', 'request-one'),
      hasCode('QUOTE_STALE'));
    const fresh = await bookings.createQuote('user-one', booking);
    const order = await bookings.createOrder('user-one', { quoteId: fresh.id }, 'fresh-address-key', 'request-two');
    assert.equal(order.snapshot.addressSnapshot.label, '修改后测试地址');
  });

  it('rejects quotes after their pet or address is deleted', async () => {
    for (const kind of ['pet', 'address']) {
      const { profiles, bookings, store } = fixture();
      const quote = await bookings.createQuote('user-one', booking);
      if (kind === 'pet') await profiles.deletePet('user-one', 'demo-cat');
      else await profiles.deleteAddress('user-one', 'demo-address');
      await assert.rejects(bookings.createOrder('user-one', { quoteId: quote.id }, 'deleted-profile-key', 'request-one'),
        hasCode(kind === 'pet' ? 'QUOTE_STALE' : 'NOT_FOUND'));
      assert.equal(await store.transaction(state => state.orders.size), 0);
    }
  });

  it('blocks pending-order deletion and preserves snapshots after edits, cancellation and deletion', async () => {
    const { profiles, bookings } = fixture();
    const quote = await bookings.createQuote('user-one', booking);
    const order = await bookings.createOrder('user-one', { quoteId: quote.id }, 'snapshot-key', 'request-one');
    await assert.rejects(profiles.deletePet('user-one', 'demo-cat'), hasCode('RESOURCE_IN_USE'));
    await assert.rejects(profiles.deleteAddress('user-one', 'demo-address'), hasCode('RESOURCE_IN_USE'));
    await profiles.updatePet('user-one', 'demo-cat', { name: '改名' });
    await profiles.updateAddress('user-one', 'demo-address', { label: '改址' });
    const replay = await bookings.createOrder('user-one', { quoteId: quote.id }, 'snapshot-key', 'request-two');
    assert.deepEqual(replay.snapshot, quote);
    await bookings.cancelUnsubmittedOrder('user-one', order.id, 'cancel-snapshot-key', 'request-three');
    await profiles.deletePet('user-one', 'demo-cat');
    await profiles.deleteAddress('user-one', 'demo-address');
    assert.deepEqual((await bookings.getOrder('user-one', order.id)).snapshot, quote);
  });

  it('serializes deletion against order creation without leaving an order with a deleted resource', async () => {
    for (const deletionFirst of [true, false]) {
      const { profiles, bookings, store } = fixture();
      const quote = await bookings.createQuote('user-one', booking);
      const create = () => bookings.createOrder('user-one', { quoteId: quote.id }, 'race-profile-key', 'request-one');
      const remove = () => profiles.deletePet('user-one', 'demo-cat');
      const results = await Promise.allSettled(deletionFirst ? [remove(), create()] : [create(), remove()]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.deepEqual(await store.transaction(state => ({ orders: state.orders.size, pet: state.pets.has('demo-cat'),
        reserved: state.slots.get('demo-slot')?.reserved })),
      deletionFirst ? { orders: 0, pet: false, reserved: 0 } : { orders: 1, pet: true, reserved: 1 });
    }
  });
});
