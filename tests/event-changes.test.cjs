const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../services/eventChanges.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function harness() {
  let event = { _id: 'event-1', name: 'Original', ownerEmail: 'owner@example.com',
    contactInfo: { email: 'public@example.com' }, isActive: true,
    membership: { tier: 'premium', period: 'month' }, ownerTier: 'premium',
    media: { photos: [{ url: 'old.jpg', description: 'Garden' }], videos: [{ url: 'old.mp4', thumbnail: 'cover.jpg' }] },
    moderation: { status: 'approved' }, viewCount: 99 };
  let submission;
  let eventWrites = 0;
  const eventDoc = () => ({ ...clone(event), toObject: () => clone(event) });
  const submissionDoc = () => {
    if (!submission) return null;
    const doc = clone(submission);
    doc.save = async () => { submission = clone(doc); };
    return doc;
  };
  const query = getter => ({ then: (resolve, reject) => Promise.resolve(getter()).then(resolve, reject), session: async () => getter() });
  const session = { endSession: async () => {}, withTransaction: async fn => {
    const oldEvent = clone(event); const oldSubmission = submission && clone(submission);
    try { await fn(); } catch (error) { event = oldEvent; submission = oldSubmission; throw error; }
  } };
  const models = {
    mongoose: { startSession: async () => session },
    '../models/Event': {
      findById: () => query(eventDoc),
      findByIdAndUpdate: async (id, update) => { assert.equal(id, event._id); eventWrites++; Object.assign(event, clone(update.$set)); return eventDoc(); }
    },
    '../models/PendingSubmission': {
      create: async data => {
        if (submission?.status === 'pending') throw Object.assign(new Error('duplicate'), { code: 11000 });
        submission = { _id: 'request-1', ...clone(data) }; return submissionDoc();
      },
      findById: () => query(submissionDoc)
    },
    '../utils/eventPublicPath': { getPublicPathFields: data => ({ slug: data.name.toLowerCase() }) }
  };
  const context = { require: name => models[name], module: { exports: {} }, console };
  vm.runInNewContext(source, context);
  const service = context.module.exports;
  return {
    service, event: () => event, submission: () => submission, writes: () => eventWrites,
    proposeEdit() { submission = { _id: 'request-1', operation: 'edit', targetEventId: event._id,
      eventSnapshot: service.snapshotEvent(event), eventDraft: { ...service.snapshotEvent(event), name: 'Proposed' },
      status: 'pending', ready: true, localMedia: { photos: [], videos: [] } }; },
    reject() { submission.status = 'rejected'; }
  };
}

test('requesting deletion preserves the live record and rejects a second pending request', async () => {
  const h = harness();
  await h.service.requestDeletion('event-1', 'owner@example.com');
  assert.equal(h.event().isActive, true); assert.equal(h.writes(), 0);
  assert.equal(h.submission().operation, 'delete');
  await assert.rejects(h.service.requestDeletion('event-1', 'owner@example.com'), /pendiente/);
});

test('public contact email does not grant permission to request deletion', async () => {
  const h = harness();
  await assert.rejects(h.service.requestDeletion('event-1', 'public@example.com'), /No autorizado/);
  assert.equal(h.submission(), undefined); assert.equal(h.writes(), 0);
});

test('approving deletion disables without removing content, owner, media or statistics', async () => {
  const h = harness(); const before = clone(h.event());
  await h.service.requestDeletion('event-1', 'owner@example.com');
  await h.service.approveEventChange('request-1', null, 'Confirmed');
  assert.equal(h.event()._id, before._id); assert.equal(h.event().isActive, false);
  assert.deepEqual(h.event().media, before.media); assert.equal(h.event().viewCount, 99);
  assert.equal(h.event().ownerEmail, before.ownerEmail); assert.equal(h.submission().status, 'approved');
  await assert.rejects(h.service.approveEventChange('request-1', null, ''), /resuelta/);
  assert.equal(h.writes(), 1);
});

test('rejection leaves the published record intact and cannot later be approved', async () => {
  const h = harness(); const before = clone(h.event()); h.proposeEdit(); h.reject();
  await assert.rejects(h.service.approveEventChange('request-1', { name: 'Proposed' }, ''), /resuelta/);
  assert.deepEqual(h.event(), before); assert.equal(h.writes(), 0);
});

test('edit approval updates the same event, preserves account fields and ignores privilege changes', async () => {
  const h = harness(); h.proposeEdit(); assert.equal(h.event().name, 'Original');
  await h.service.approveEventChange('request-1', { name: 'Proposed', ownerEmail: 'intruder@example.com',
    ownerTier: 'free', membership: { tier: 'free' }, isActive: false,
    media: { photos: [{ url: 'new.jpg' }], videos: [{ url: 'old.mp4', thumbnail: 'cover.jpg' }] } }, 'OK');
  assert.equal(h.event().name, 'Proposed'); assert.equal(h.event()._id, 'event-1');
  assert.equal(h.event().ownerEmail, 'owner@example.com'); assert.equal(h.event().isActive, true);
  assert.equal(h.event().membership.tier, 'premium'); assert.equal(h.event().viewCount, 99);
  assert.equal(h.event().media.photos[0].url, 'new.jpg');
  assert.equal(h.submission().status, 'approved');
});

test('stale edits cannot overwrite a newer public version, while view counts do not conflict', async () => {
  const h = harness(); h.proposeEdit(); h.event().name = 'Newer version';
  await assert.rejects(h.service.approveEventChange('request-1', { name: 'Proposed' }, ''), /cambio desde/);
  assert.equal(h.event().name, 'Newer version'); assert.equal(h.submission().status, 'pending');
  const fresh = harness(); fresh.proposeEdit(); fresh.event().viewCount++;
  await fresh.service.approveEventChange('request-1', { name: 'Proposed' }, '');
  assert.equal(fresh.event().viewCount, 100);
});

test('a review modified during media processing must be loaded again before approval', async () => {
  const h = harness(); h.proposeEdit(); const expected = clone(h.submission());
  h.submission().eventDraft.name = 'Changed by reviewer';
  await assert.rejects(h.service.approveEventChange('request-1', { name: 'Proposed' }, '', expected), /editada durante/);
  assert.equal(h.writes(), 0);
});

test('editor hydrates membership, preferred contact and video metadata without resetting them', () => {
  const file = fs.readFileSync(path.join(__dirname, '../../client/app/mis-propiedades/[id]/editar/page.js'), 'utf8');
  const context = { toDateInputValue: value => value || '' };
  vm.runInNewContext(file.slice(file.indexOf('const emptyFormData'), file.indexOf('export default')) + ';this.build = buildFormData;', context);
  const event = harness().event(); event.preferredContactMethod = 'whatsapp';
  const form = context.build(event);
  assert.equal(form.membership.tier, 'premium'); assert.equal(form.membership.period, 'month');
  assert.equal(form.preferredContactMethod, 'whatsapp'); assert.equal(form.media.videos[0].thumbnail, 'cover.jpg');
  assert.equal(form.media.photoLinks[0], 'old.jpg');
});

test('edit request sends multipart files, operation, target and authentication', async () => {
  const file = fs.readFileSync(path.join(__dirname, '../../client/lib/api.js'), 'utf8');
  const part = file.slice(file.indexOf('  submitPublicationForReview: async'), file.indexOf('  getOwnerSubmissions: async'));
  let sent;
  const context = { FormData, API_URL: 'https://example.test', authHeaders: () => ({ Authorization: 'Bearer test' }),
    readJson: async () => ({ id: 'request-1' }), fetch: async (url, options) => { sent = options; return { ok: true }; } };
  vm.runInNewContext('this.submit = ' + part.replace('  submitPublicationForReview: ', '').trim().replace(/,$/, '') + ';', context);
  await context.submit({ eventDraft: { name: 'Edited' }, operation: 'edit', targetEventId: 'event-1', photos: [new Blob(['image'])] });
  assert.equal(sent.body.get('operation'), 'edit'); assert.equal(sent.body.get('targetEventId'), 'event-1');
  assert.equal(sent.body.getAll('photos').length, 1); assert.equal(sent.headers.Authorization, 'Bearer test');
});

test('public batch refresh excludes disabled and unapproved events, including stale landing entries', async () => {
  const file = fs.readFileSync(path.join(__dirname, '../routes/events.js'), 'utf8');
  const filters = file.slice(file.indexOf('const APPROVED_QUERY ='), file.indexOf('const PUBLIC_EVENT_PAGE_SELECT'));
  const route = file.slice(file.indexOf("router.get('/public-batch'"), file.indexOf("router.get('/featured'"));
  let handler, receivedFilter;
  const context = { ...require('../utils/publicEvent'), mongoose: { isValidObjectId: id => /^[a-f\d]{24}$/i.test(id) },
    router: { get: (name, fn) => { handler = fn; } },
    Event: { find: filter => { receivedFilter = filter; return { select: () => ({ lean: async () => [] }) }; } } };
  vm.runInNewContext(filters + route, context);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, set(key, value) { this[key] = value; }, json(value) { this.body = value; return this; } };
  await handler({ query: { ids: 'aaaaaaaaaaaaaaaaaaaaaaaa' } }, res);
  assert.equal(receivedFilter.isActive.$ne, false);
  assert.equal(receivedFilter.$or[0]['moderation.status'], 'approved');
  assert.equal(res['Cache-Control'], 'no-store');
  await handler({ query: { ids: 'invalid-id' } }, res);
  assert.equal(res.statusCode, 400);
});

test('legacy public detail endpoint also excludes disabled and pending records', async () => {
  let receivedFilter;
  const context = { exports: {}, console, require: () => ({ findOneAndUpdate: filter => {
    receivedFilter = filter; return { select: () => ({ lean: async () => null }) };
  } }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../controllers/getEventById.js'), 'utf8'), context);
  const res = { status(code) { this.code = code; return this; }, json() {} };
  await context.exports.getEventById({ params: { id: 'event-1' } }, res);
  assert.equal(receivedFilter.isActive.$ne, false);
  assert.equal(receivedFilter.$or[0]['moderation.status'], 'approved');
  assert.equal(res.code, 404);
});

test('reviewer can remove a pending photo and add its replacement without changing the Event', async () => {
  const file = fs.readFileSync(path.join(__dirname, '../routes/submissions.js'), 'utf8');
  const route = file.slice(file.indexOf("router.post('/:id/media'"), file.indexOf("router.post('/:id/reject'"));
  let handler, updatedMedia;
  const pending = { _id: 'request-1', operation: 'edit', status: 'pending', ready: true, updatedAt: new Date(),
    localMedia: { photos: [{ filename: 'remove.jpg' }, { filename: 'keep.jpg' }], videos: [] } };
  const context = {
    router: { post: (...args) => { handler = args.at(-1); } }, ensureReviewAccess: () => {},
    upload: { fields: () => () => {} }, path, __dirname,
    crypto: { randomUUID: () => 'new-photo' }, sanitizeFilename: name => name,
    fs: { mkdir: async () => {}, writeFile: async () => {}, unlink: async () => {} },
    PendingSubmission: { findById: async () => pending, findOneAndUpdate: async (filter, update) => {
      assert.equal(filter.status, 'pending'); updatedMedia = update.$set.localMedia;
      return { ...pending, localMedia: updatedMedia };
    } }
  };
  vm.runInNewContext(route, context);
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ params: { id: 'request-1' }, body: { removePhotoIndexes: '[0]' }, files: {
    photos: [{ originalname: 'replacement.jpg', size: 5, mimetype: 'image/jpeg', buffer: Buffer.from('image') }]
  } }, res);
  assert.equal(res.body.ok, true); assert.equal(updatedMedia.photos.length, 2);
  assert.equal(updatedMedia.photos[0].filename, 'keep.jpg');
  assert.equal(updatedMedia.photos[1].filename, 'replacement.jpg');
  pending.operation = 'delete';
  await handler({ params: { id: 'request-1' }, body: {} }, res);
  assert.equal(res.code, 409);
});
