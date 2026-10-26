import { randomUUID } from 'node:crypto';
import { conflict, identifier, invalid, notFound, objectInput, onlyFields } from './errors.ts';
import type { Address, Pet } from './models.ts';
import type { BookingStore, EntityTable, Repository } from '../storage/booking-store.ts';

function text(value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string') invalid(`${field} must be text`);
  const trimmed = value.trim();
  if ((!allowEmpty && trimmed.length === 0) || trimmed.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(trimmed)
    || (field !== 'careNotes' && /[\t\r\n]/u.test(trimmed))) {
    invalid(`Invalid ${field}`);
  }
  return trimmed;
}

function petFields(value: unknown, partial: boolean) {
  const input = objectInput(value);
  onlyFields(input, ['name', 'type', 'careNotes']);
  if (partial && Object.keys(input).length === 0) invalid('At least one field is required');
  const fields: Partial<Pick<Pet, 'name' | 'type' | 'careNotes'>> = {};
  if (!partial || 'name' in input) fields.name = text(input.name, 'name', 80);
  if (!partial || 'type' in input) {
    if (input.type !== 'CAT' && input.type !== 'DOG') invalid('type must be CAT or DOG');
    fields.type = input.type;
  }
  if ('careNotes' in input) fields.careNotes = text(input.careNotes, 'careNotes', 2000, true);
  return fields;
}

function addressFields(value: unknown, partial: boolean) {
  const input = objectInput(value);
  onlyFields(input, ['areaId', 'label']);
  if (partial && Object.keys(input).length === 0) invalid('At least one field is required');
  const fields: Partial<Pick<Address, 'areaId' | 'label'>> = {};
  if (!partial || 'areaId' in input) fields.areaId = identifier(input.areaId, 'areaId');
  if (!partial || 'label' in input) fields.label = text(input.label, 'label', 200);
  return fields;
}

async function owned<Resource extends { userId: string }>(resources: EntityTable<Resource>, userId: string, id: string) {
  const resource = await resources.get(id);
  if (!resource || resource.userId !== userId) return notFound();
  return resource;
}

export class ProfileService {
  private readonly store: BookingStore;

  constructor(store: BookingStore) {
    this.store = store;
  }

  listPets(userId: string) {
    return this.store.run(userId, state => state.pets.list({ userId }));
  }

  getPet(userId: string, petId: string) {
    identifier(petId, 'petId');
    return this.store.run(userId, state => owned(state.pets, userId, petId));
  }

  createPet(userId: string, value: unknown) {
    const fields = petFields(value, false);
    return this.store.run(userId, async state => {
      const pet: Pet = { id: randomUUID(), userId, name: fields.name!, type: fields.type!,
        careNotes: fields.careNotes ?? '' };
      await state.pets.put(pet.id, pet);
      return pet;
    });
  }

  updatePet(userId: string, petId: string, value: unknown) {
    identifier(petId, 'petId');
    const fields = petFields(value, true);
    return this.store.run(userId, async state => {
      const pet = Object.assign(await owned(state.pets, userId, petId), fields);
      await state.pets.put(petId, pet);
      return pet;
    });
  }

  deletePet(userId: string, petId: string) {
    identifier(petId, 'petId');
    return this.store.run(userId, async state => {
      await owned(state.pets, userId, petId);
      await this.assertUnused(state, userId, 'pet', petId);
      await state.pets.remove(petId);
      return { id: petId, deleted: true };
    });
  }

  listAddresses(userId: string) {
    return this.store.run(userId, state => state.addresses.list({ userId }));
  }

  getAddress(userId: string, addressId: string) {
    identifier(addressId, 'addressId');
    return this.store.run(userId, state => owned(state.addresses, userId, addressId));
  }

  createAddress(userId: string, value: unknown) {
    const fields = addressFields(value, false);
    return this.store.run(userId, async state => {
      await this.assertArea(state, fields.areaId!);
      const address: Address = { id: randomUUID(), userId, areaId: fields.areaId!, label: fields.label! };
      await state.addresses.put(address.id, address);
      return address;
    });
  }

  updateAddress(userId: string, addressId: string, value: unknown) {
    identifier(addressId, 'addressId');
    const fields = addressFields(value, true);
    return this.store.run(userId, async state => {
      const address = await owned(state.addresses, userId, addressId);
      if (fields.areaId !== undefined) await this.assertArea(state, fields.areaId);
      Object.assign(address, fields);
      await state.addresses.put(addressId, address);
      return address;
    });
  }

  deleteAddress(userId: string, addressId: string) {
    identifier(addressId, 'addressId');
    return this.store.run(userId, async state => {
      await owned(state.addresses, userId, addressId);
      await this.assertUnused(state, userId, 'address', addressId);
      await state.addresses.remove(addressId);
      return { id: addressId, deleted: true };
    });
  }

  private async assertArea(state: Repository, areaId: string) {
    for (const slot of await state.slots.list({ active: true, areaId })) {
      if ((await state.services.get(slot.serviceId))?.active) return;
    }
    conflict('AREA_UNAVAILABLE', 'Choose an area with configured active service slots');
  }

  private async assertUnused(state: Repository, userId: string, kind: 'pet' | 'address', id: string) {
    if (await state.resourceInUse(userId, kind, id)) {
      conflict('RESOURCE_IN_USE', 'Cancel the pending order before deleting this resource');
    }
  }
}
