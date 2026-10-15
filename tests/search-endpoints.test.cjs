const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildLocationQuery, buildNameQuery } = require('../utils/locationSearch');

const { buildOccasionQuery } = require('../utils/occasionSearch');
const { PUBLIC_EVENT_SELECT } = require('../utils/publicEvent');
const source = fs.readFileSync(path.join(__dirname, '../routes/events.js'), 'utf8');
const approved = source.slice(source.indexOf('const APPROVED_QUERY ='), source.indexOf('const PUBLIC_EVENT_LITE_SELECT'));
const routes = source.slice(source.indexOf("router.get('/search'"), source.indexOf("router.get('/featured'"));
const fixture = (name, city, district, status = 'approved') => ({ name, location: { city, district, province: 'Buenos Aires', address: 'Calle Palermo' }, type: 'salon', moderation: { status } });
const fixtures = [
  fixture('Salón Jardín', 'Mar del Plata', 'Los Troncos'),
  fixture('Jardin Norte', 'Mar del Plata', 'Centro'),
  fixture('Jardin Sur', 'La Plata', 'Los Troncos'),
  fixture('Jardin privado', 'Mar del Plata', 'Oculto', 'pending'),
  { ...fixture('Jardin inhabilitado', 'Mar del Plata', 'Centro'), isActive: false },
  fixture('Jardin rechazado', 'Mar del Plata', 'Otro', 'rejected')
];
function matches(document, query) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$or') return condition.some((entry) => matches(document, entry));
    if (key === '$and') return condition.every((entry) => matches(document, entry));
    const value = key.split('.').reduce((object, part) => object?.[part], document);
    if (condition && typeof condition === 'object' && '$in' in condition) return (Array.isArray(value) ? value : [value]).some(v => condition.$in.some(item => item?.test ? item.test(v || '') : item === v));
    if (condition?.test) return condition.test(value || '');
    if (condition && typeof condition === 'object' && '$ne' in condition) return value !== condition.$ne;
    if (condition && typeof condition === 'object' && '$exists' in condition) return (value !== undefined) === condition.$exists;
    return value === condition;
  });
}
async function request(route, query, data = fixtures, nameQuery = buildNameQuery) {
  const handlers = {};
  let payload;
  let status = 200;
  vm.runInNewContext(approved + routes, {
    router: { get: (name, handler) => { handlers[name] = handler; } },
    buildLocationQuery, buildNameQuery: nameQuery, buildOccasionQuery, PUBLIC_EVENT_SELECT,
    Event: {
      find: (filter) => ({ select: (fields) => ({ sort: async () => data.filter((doc) => matches(doc, filter)).map(doc => Object.fromEntries(Object.entries(doc).filter(([key]) => fields.split(' ').includes(key)))) }) }),
      distinct: async (field, filter) => data.filter((doc) => matches(doc, filter)).map((doc) => doc.location.district)
    }
  });
  const res = { status(code) { status = code; return res; }, json(value) { payload = value; return res; } };
  await handlers[route]({ query }, res);
  return { status, payload };
}

test('name search excludes matches only in address, province, city or type', async () => {
  for (const q of ['Palermo', 'Buenos Aires', 'Mar del Plata', 'salon inexistente']) {
    const { payload } = await request('/search', { q });
    assert.equal(payload.count, 0, q);
  }
  const { payload } = await request('/search', { q: 'jardin' });
  assert.equal(payload.count, 3);
  assert.ok(payload.events.every(event => !['Jardin privado', 'Jardin rechazado', 'Jardin inhabilitado'].includes(event.name)));
});

test('city filtering ignores legacy district parameters and preserves moderation', async () => {
  const { payload } = await request('/search', { q: 'JARDIN', city: 'Mar del Plata', district: 'Los Troncos' });
  assert.equal(payload.count, 2);
  assert.ok(payload.events.every(event => event.location.city === 'Mar del Plata'));
  assert.ok(payload.events.every(event => !['Jardin privado', 'Jardin rechazado'].includes(event.name)));
  assert.equal((await request('/search', { city: 'Mar del Plata', district: 'No existe' })).payload.count, 2);
});

test('search treats regex characters as text', async () => {
  assert.equal((await request('/search', { q: '.*' })).payload.count, 0);
});

test('search preserves moderation with text, blank text and legacy records', async () => {
  const legacy = fixture('Jardin antiguo', 'Mar del Plata', 'Centro');
  delete legacy.moderation;
  const withoutStatus = fixture('Jardin sin estado', 'Mar del Plata', 'Centro');
  withoutStatus.moderation = {};
  const data = [...fixtures, legacy, withoutStatus];
  for (const query of [{}, { q: '' }, { q: '   ' }, { q: 'jardin' }]) {
    const { status, payload } = await request('/search', query, data);
    assert.equal(status, 200);
    assert.equal(payload.count, 5);
    assert.ok(payload.events.every((event) => !['pending', 'rejected'].includes(event.moderation?.status)));
    assert.ok(payload.events.some(event => event.name === legacy.name));
    assert.ok(payload.events.some(event => event.name === withoutStatus.name));
  }
});

test('an OR text filter cannot overwrite the approval condition', async () => {
  const { status, payload } = await request('/search', { q: 'jardin' }, fixtures,
    () => ({ $or: [{ name: /jardin/i }, { name: /jard\u00edn/i }] }));
  assert.equal(status, 200);
  assert.equal(payload.count, 3);
  assert.ok(payload.events.every(event => !['Jardin privado', 'Jardin rechazado', 'Jardin inhabilitado'].includes(event.name)));
});

test('occasion filters match venue classifications and exclude unclassified venues', async () => {
  const venue = (name, partyTypes, eventType) => ({ ...fixture(name, 'La Plata', 'Centro'), partyTypes, eventType });
  const data = [
    venue('Wedding', ['boda']), venue('Birthday', ['cumpleaños']),
    venue('Kids', ['cumpleaños-infantil']), venue('Fifteen', ['quinceaños']),
    venue('Business', ['empresarial']), venue('Graduation', ['egresados']),
    venue('Other', ['otro']), venue('Legacy wedding', undefined, 'boda'),
    venue('Unclassified', undefined, 'otro'), venue('Empty', [], undefined)
  ];
  const expected = {
    casamiento: ['Wedding', 'Legacy wedding'], cumpleanios: ['Birthday', 'Kids'],
    'cumpleanios-infantil': ['Kids'], xv: ['Fifteen'], empresarial: ['Business'],
    egresados: ['Graduation'], otro: ['Other']
  };
  for (const [occasion, names] of Object.entries(expected)) {
    const { status, payload } = await request('/search', { occasion }, data);
    assert.equal(status, 200);
    assert.deepEqual(payload.events.map(event => event.name), names);
  }
  assert.equal((await request('/search', {}, data)).payload.count, data.length);
  assert.equal((await request('/search', { occasion: 'invalid' }, data)).status, 400);
});

test('occasion combines with location, text and publication visibility', async () => {
  const data = [
    { ...fixture('Wedding', 'La Plata', 'Centro'), partyTypes: ['boda'] },
    { ...fixture('Wedding elsewhere', 'Moron', 'Centro'), partyTypes: ['boda'] },
    { ...fixture('Wedding pending', 'La Plata', 'Centro', 'pending'), partyTypes: ['boda'] },
    { ...fixture('Wedding disabled', 'La Plata', 'Centro'), partyTypes: ['boda'], isActive: false },
    { ...fixture('Birthday', 'La Plata', 'Centro'), partyTypes: ['cumpleaños'] }
  ];
  const { payload } = await request('/search', { occasion: 'casamiento', city: 'La Plata', q: 'Wedding' }, data);
  assert.deepEqual(payload.events.map(event => event.name), ['Wedding']);
});

test('legacy budget parameters no longer filter incomparable amounts', async () => {
  const normal = await request('/search', {});
  const budget = await request('/search', { minPrice: '999999999', maxPrice: '0' });
  assert.deepEqual(budget.payload.events, normal.payload.events);
});

test('public search returns useful fields but strips ownership and moderation data', async () => {
  const document = { ...fixture('Venue', 'La Plata', 'Centro'), ownerEmail: 'private@example.com',
    moderation: { status: 'approved', reviewedBy: 'reviewer@example.com', reason: 'Internal note' },
    contactInfo: { email: 'public@example.com' }, pricing: { perDay: 500, perDayCurrency: 'USD' },
    membership: { tier: 'premium' }, media: { photos: [{ url: 'photo.jpg' }] } };
  const { payload } = await request('/search', {}, [document]);
  assert.equal(payload.events[0].ownerEmail, undefined);
  assert.equal(payload.events[0].moderation, undefined);
  assert.equal(payload.events[0].membership, undefined);
  assert.equal(payload.events[0].contactInfo.email, 'public@example.com');
  assert.equal(payload.events[0].pricing.perDayCurrency, 'USD');
  assert.equal(payload.events[0].media.photos[0].url, 'photo.jpg');
});

test('public detail applies the same explicit projection', async () => {
  const start = source.indexOf("router.get('/:id', async");
  const end = source.indexOf("router.post('/:id/claim-owner'", start);
  let handler;
  const sensitive = { _id: 'venue', name: 'Venue', ownerEmail: 'private@example.com',
    moderation: { reviewedBy: 'admin@example.com', reason: 'Internal' }, contactInfo: { email: 'public@example.com' } };
  vm.runInNewContext(approved + source.slice(start, end), {
    PUBLIC_EVENT_SELECT,
    router: { get: (_, fn) => { handler = fn; } },
    Event: { findOne: () => ({ select: async fields => Object.fromEntries(Object.entries(sensitive).filter(([key]) => fields.split(' ').includes(key))) }) }
  });
  let result;
  await handler({ params: { id: 'venue' } }, { json: data => { result = data; }, status() { return this; } });
  assert.equal(result.name, 'Venue'); assert.equal(result.ownerEmail, undefined);
  assert.equal(result.moderation, undefined); assert.equal(result.contactInfo.email, 'public@example.com');
});
