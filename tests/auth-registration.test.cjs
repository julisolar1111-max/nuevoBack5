const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }, set(k,v) { this.headers[k] = v; return this; } };
}
function authHarness({ blocked = false, existing = true } = {}) {
  const routes = {};
  const updates = [];
  const owner = { _id: 'owner-1', email: 'person@example.com', username: 'person', passwordHash: 'existing-password', moderation: { isBlocked: blocked }, save: async () => {} };
  let created = 0, sessions = 0, revoked = 0;
  const router = {};
  for (const method of ['get','post','put','delete']) router[method] = (route, ...handlers) => routes[method + ' ' + route] = handlers;
  const mocks = {
    '../utils/publicEvent': require('../utils/publicEvent'),
    express: { Router: () => router }, crypto,
    '../models/Owner': { findOne: async () => existing ? owner : null, create: async data => { created++; return { ...owner, ...data }; } },
    '../models/Contact': { findOne: async () => ({ name: 'Custom profile', membership: { tier: 'premium' } }), findOneAndUpdate: async (...args) => updates.push(args) },
    '../models/Event': { countDocuments: async () => 1 },
    '../models/OwnerOtp': { findOne: () => ({ sort: async () => ({ codeHash: crypto.createHash('sha256').update('123456').digest('hex'), expiresAt: new Date(Date.now() + 60000), scope: 'generic' }) }), deleteMany: async () => {} },
    '../models/OwnerSession': { create: async () => sessions++, findOne: () => ({ populate: async () => ({ _id: 'session', ownerId: owner, expiresAt: new Date(Date.now() + 60000) }) }), deleteMany: async () => revoked++ },
    '../services/transactionalEmail': {},
    '../services/ownerRanking': { buildOwnerResponse: async o => ({ email: o.email }) },
    '../services/otpLimits': { limitOtpAttempts: () => (req,res,next) => next() },
    'google-auth-library': { OAuth2Client: class { async verifyIdToken() { return { getPayload: () => ({ email: 'PERSON@example.com', sub: 'google-1', email_verified: true, name: 'Google name' }) }; } } }
  };
  const context = { require: name => { if (!(name in mocks)) throw Error(name); return mocks[name]; }, module: { exports: {} }, process: { env: { GOOGLE_CLIENT_ID: 'test', NODE_ENV: 'production' } }, console, Buffer };
  vm.runInNewContext(read('routes/auth.js'), context);
  return { routes, updates, owner, exported: context.module.exports, stats: () => ({ created, sessions, revoked }) };
}
test('Google reuses the normalized email account and preserves password and contact preferences', async () => {
  const h = authHarness(); const res = response();
  await h.routes['post /google'].at(-1)({ body: { idToken: 'valid' } }, res);
  assert.equal(res.statusCode, 200); assert.equal(h.stats().created, 0); assert.equal(h.stats().sessions, 1);
  assert.equal(res.body.owner.email, 'person@example.com'); assert.equal(h.owner.passwordHash, 'existing-password');
  assert.equal(h.owner.googleSub, 'google-1');
  assert.ok(h.updates[0][1].$setOnInsert); assert.equal(h.updates[0][1].$set.isOwner, true); assert.equal(h.updates[0][1].$set.name, undefined); assert.equal(h.updates[0][1].$set.membership, undefined);
});
test('Google creates an account containing the verified email', async () => {
  const h = authHarness({ existing: false }); const res = response();
  await h.routes['post /google'].at(-1)({ body: { idToken: 'valid' } }, res);
  assert.equal(h.stats().created, 1); assert.equal(res.body.owner.email, 'person@example.com');
});
test('blocked users cannot log in by password or Google', async () => {
  for (const route of ['post /login', 'post /google']) {
    const h = authHarness({ blocked: true }); const res = response();
    await h.routes[route].at(-1)({ body: { email: 'person@example.com', password: 'secret', idToken: 'valid' } }, res);
    assert.equal(res.statusCode, 403); assert.equal(h.stats().sessions, 0);
  }
});
test('a blocked existing session is denied and revoked', async () => {
  const h = authHarness({ blocked: true }); const res = response(); let allowed = false;
  await h.exported.requireOwnerAuth({ headers: { authorization: 'Bearer token' } }, res, () => allowed = true);
  assert.equal(res.statusCode, 403); assert.equal(allowed, false); assert.equal(h.stats().revoked, 1);
});
test('IP limiter permits three attempts, isolates IPs, and resend does not reset verification', async () => {
  const entries = new Map();
  const store = { async findOneAndUpdate(query) { const count = (entries.get(query._id) || 0) + 1; entries.set(query._id, count); return { count }; } };
  const context = { require: name => name === 'crypto' ? crypto : store, module: { exports: {} } };
  vm.runInNewContext(read('services/otpLimits.js'), context);
  let time = 1200000;
  const limit = context.module.exports.createLimiter(store, () => time);
  async function request(kind, ip) { const res = response(); await limit(kind)({ ip }, res, () => res.allowed = true); return res; }
  for (let i = 0; i < 3; i++) assert.equal((await request('verify', 'ip-a')).allowed, true);
  assert.equal((await request('verify', 'ip-a')).statusCode, 429);
  assert.equal((await request('send', 'ip-a')).allowed, true);
  assert.equal((await request('verify', 'ip-a')).statusCode, 429);
  assert.equal((await request('verify', 'ip-b')).allowed, true);
  time += 600000;
  assert.equal((await request('verify', 'ip-a')).allowed, true);
});

function publicationHarness(authenticated = true, targetEvent = null) {
  let handler, saved;
  const owner = { email: 'owner@example.com' };
  const context = {
    router: { post(route, upload, fn) { handler = fn; } },
    upload: { fields: () => () => {} },
    requireOwnerAuth: async (req,res,next) => { if (!authenticated) return res.status(401).json({ message: 'No autorizado' }); req.owner = owner; next(); },
    isMasterSubmissionRequest: () => false,
    Event: { findById: async () => targetEvent },
    ownsEvent: (event, email) => event.ownerEmail === email,
    snapshotEvent: event => JSON.parse(JSON.stringify(event)),
    EDITABLE_FIELDS: ['name', 'media', 'contactInfo'],
    pick: (value, fields) => Object.fromEntries(Object.entries(value).filter(([key]) => fields.includes(key))),
    normalizeEmail: value => String(value || '').trim().toLowerCase(),
    isSyntheticMasterOwnerEmail: () => false, isOwnerBlocked: async () => false,
    findDuplicateEventByOwner: async () => null,
    PendingSubmission: { exists: async () => false, create: async data => { saved = { ...data, _id: 'pending-1', save: async () => {} }; return saved; } },
    Contact: { updateOne: async () => {} },
    path, __dirname, fs: { mkdir: async () => {}, writeFile: async () => {} },
    sanitizeFilename: value => value,
    maybeSendPublicationLimitAlert: async () => {},
  };
  const source = read('routes/submissions.js');
  vm.runInNewContext(source.slice(source.indexOf('router.post('), source.indexOf("router.get('/mine'")), context);
  return { run: handler, saved: () => saved };
}
test('publication requires authentication and cannot create a pending request anonymously', async () => {
  const h = publicationHarness(false); const res = response();
  await h.run({ body: { approvedByOwner: 'true', eventDraft: JSON.stringify({ contactInfo: { email: 'contact@example.com' } }) } }, res);
  assert.equal(res.statusCode, 401); assert.equal(h.saved(), undefined);
});
test('publication belongs to authenticated account while retaining a separate public email', async () => {
  const h = publicationHarness(); const res = response();
  await h.run({ body: { approvedByOwner: 'true', eventDraft: JSON.stringify({ name: 'First space', ownerEmail: 'spoof@example.com', contactInfo: { email: 'contact@example.com' } }) } }, res);
  assert.equal(res.statusCode, 201); assert.equal(h.saved().status, 'pending');
  assert.equal(h.saved().eventDraft.ownerEmail, 'owner@example.com');
  assert.equal(h.saved().eventDraft.contactInfo.email, 'contact@example.com');
});
test('approval marks owner without replacing the personal profile name', () => {
  const source = read('routes/submissions.js');
  const context = { normalizeEmail: value => value.toLowerCase() };
  vm.runInNewContext(source.slice(source.indexOf('const buildContactUpsert ='), source.indexOf('const sanitizeFilename =')) + ';this.build = buildContactUpsert;', context);
  for (const name of ['First space', 'Second space']) {
    const result = context.build({ ownerEmail: 'owner@example.com', name, contactInfo: {} });
    assert.equal(result.doc.isOwner, true); assert.equal(result.doc.name, undefined);
    assert.equal(result.email, 'owner@example.com');
  }
});
test('pending panel returns multiple spaces scoped only to the authenticated owner', async () => {
  let handler, query;
  const source = read('routes/submissions.js');
  const rows = ['First', 'Second'].map((name, index) => ({ _id: String(index), status: 'pending', eventDraft: { name } }));
  const context = {
    router: { get(route, auth, fn) { handler = fn; } }, requireOwnerAuth: () => {},
    PendingSubmission: { find(q) { query = q; return { select: () => ({ sort: () => ({ lean: async () => rows }) }) }; } }
  };
  vm.runInNewContext(source.slice(source.indexOf("router.get('/mine'"), source.indexOf("router.get('/', ensureReviewAccess")), context);
  const res = response(); await handler({ owner: { email: 'owner@example.com' } }, res);
  assert.equal(query['eventDraft.ownerEmail'], 'owner@example.com'); assert.equal(res.body.length, 2);
  assert.ok(res.body.every(row => row.isSubmission));
});

test('blocked users cannot enter through a valid email code', async () => {
  const h = authHarness({ blocked: true }); const res = response();
  await h.routes['post /verify-otp'].at(-1)({ body: { email: 'person@example.com', code: '123456', password: 'secret' } }, res);
  assert.equal(res.statusCode, 403); assert.equal(h.stats().sessions, 0);
});
test('email code preserves proprietor status for an account with events', async () => {
  const h = authHarness(); const res = response();
  await h.routes['post /verify-otp'].at(-1)({ body: { email: 'person@example.com', code: '123456', password: 'secret', isOwner: false } }, res);
  assert.equal(res.statusCode, 200); assert.equal(h.updates[0][1].$set.isOwner, true);
});

test('editing creates a media-backed pending request without changing the existing event', async () => {
  const original = { _id: 'event-1', name: 'Original', ownerEmail: 'owner@example.com', membership: { tier: 'premium' }, isActive: true };
  const h = publicationHarness(true, original); const res = response();
  await h.run({ body: { approvedByOwner: 'true', operation: 'edit', targetEventId: 'event-1', eventDraft: JSON.stringify({ name: 'Proposed', ownerEmail: 'spoof@example.com', membership: { tier: 'free' }, media: { photoLinks: ['old.jpg'] } }) }, files: { photos: [{ originalname: 'new.jpg', buffer: Buffer.from('image'), size: 5, mimetype: 'image/jpeg' }] } }, res);
  assert.equal(res.statusCode, 201); assert.equal(original.name, 'Original');
  assert.equal(h.saved().operation, 'edit'); assert.equal(h.saved().targetEventId, 'event-1');
  assert.equal(h.saved().eventDraft.name, 'Proposed'); assert.equal(h.saved().eventDraft.membership.tier, 'premium');
  assert.equal(h.saved().eventSnapshot.name, 'Original'); assert.equal(h.saved().localMedia.photos.length, 1);
  assert.equal(h.saved().ready, true);
});
test('editing someone elses event is rejected before a request is created', async () => {
  const h = publicationHarness(true, { _id: 'event-1', ownerEmail: 'other@example.com' }); const res = response();
  await h.run({ body: { approvedByOwner: 'true', operation: 'edit', targetEventId: 'event-1', eventDraft: '{}' } }, res);
  assert.equal(res.statusCode, 403); assert.equal(h.saved(), undefined);
});
