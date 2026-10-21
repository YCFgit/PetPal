import { emptyState } from '../domain/models.ts';

export function demoState(userId = 'local-user', now = new Date()) {
  const state = emptyState();
  state.services.set('demo-cat-care', {
    id: 'demo-cat-care', name: '开发示例：上门喂猫（非经营报价）', petType: 'CAT',
    durationMinutes: 30, basePriceFen: 5000, extraPetPriceFen: 1000, maxPets: 3,
    priceVersion: 'demo-v1', ruleVersion: 'draft-v1', active: true,
  });
  state.pets.set('demo-cat', {
    id: 'demo-cat', userId, name: '示例猫咪', type: 'CAT', careNotes: '仅供开发，不含真实宠物资料',
  });
  state.addresses.set('demo-address', {
    id: 'demo-address', userId, areaId: 'demo-area', label: '开发示例区域，非真实住址',
  });
  const startsAt = new Date(now.getTime() + 24 * 60 * 60_000);
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
  state.slots.set('demo-slot', {
    id: 'demo-slot', serviceId: 'demo-cat-care', areaId: 'demo-area',
    startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
    capacity: 1, reserved: 0, active: true,
  });
  return state;
}
