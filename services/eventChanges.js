const mongoose = require('mongoose');
const Event = require('../models/Event');
const PendingSubmission = require('../models/PendingSubmission');
const { getPublicPathFields } = require('../utils/eventPublicPath');

const EDITABLE_FIELDS = ['name', 'description', 'type', 'eventType', 'location', 'capacity',
  'partyTypes', 'contactInfo', 'preferredContactMethod', 'plans', 'pricing', 'priceRange', 'media'];
const pick = (value, fields) => Object.fromEntries(fields
  .filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const snapshotEvent = event => JSON.parse(JSON.stringify(pick(
  event?.toObject ? event.toObject() : event,
  [...EDITABLE_FIELDS, 'ownerEmail', 'ownerTier', 'membership', 'isActive']
)));
const ownsEvent = (event, email) => String(event?.ownerEmail || event?.contactInfo?.email || '')
  .trim().toLowerCase() === String(email || '').trim().toLowerCase();
const changeError = (message, status = 409) => Object.assign(new Error(message), { status });
const canonical = value => JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

async function requestDeletion(eventId, email) {
  const event = await Event.findById(eventId);
  if (!event) throw changeError('Publicacion no encontrada', 404);
  if (!ownsEvent(event, email)) throw changeError('No autorizado', 403);
  if (event.isActive === false) throw changeError('La publicacion ya esta inhabilitada');
  const snapshot = snapshotEvent(event);
  try {
    return await PendingSubmission.create({
      operation: 'delete', targetEventId: event._id, eventSnapshot: snapshot,
      eventDraft: { ...snapshot, ownerEmail: email }, status: 'pending', ready: true,
      moderation: { approvedByOwner: true }
    });
  } catch (error) {
    if (error.code === 11000) throw changeError('Ya hay una solicitud pendiente para este espacio');
    throw error;
  }
}

// The event and review decision commit together. A competing review cannot apply twice.
async function approveEventChange(submissionId, payload, note, expectedSubmission) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const submission = await PendingSubmission.findById(submissionId).session(session);
      if (!submission || submission.status !== 'pending' || submission.ready === false) {
        throw changeError('La solicitud ya fue resuelta o no esta lista');
      }
      if (expectedSubmission && canonical({ draft: submission.eventDraft, media: submission.localMedia }) !== canonical({ draft: expectedSubmission.eventDraft, media: expectedSubmission.localMedia })) {
        throw changeError('La solicitud fue editada durante la aprobacion. Recarga y revisa los cambios');
      }
      if (!['edit', 'delete'].includes(submission.operation)) throw changeError('Operacion invalida');
      const event = await Event.findById(submission.targetEventId).session(session);
      if (!event) throw changeError('La publicacion original ya no existe', 404);
      if (!ownsEvent(event, submission.eventDraft.ownerEmail)) throw changeError('El propietario cambio; rechaza esta solicitud');
      if (event.isActive === false) throw changeError('La publicacion ya esta inhabilitada');
      if (canonical(snapshotEvent(event)) !== canonical(submission.eventSnapshot)) {
        throw changeError('La publicacion cambio desde la solicitud. Rechazala y solicita una nueva revision');
      }
      const update = submission.operation === 'delete'
        ? { isActive: false, disabledAt: new Date(), disabledReason: 'owner-request' }
        : {
          ...pick(payload, EDITABLE_FIELDS),
          ...getPublicPathFields({ ...event.toObject(), ...pick(payload, EDITABLE_FIELDS) }),
          moderation: { status: 'approved', reviewedAt: new Date(), reviewedBy: 'manual-review' }
        };
      result = await Event.findByIdAndUpdate(event._id, { $set: update }, {
        new: true, runValidators: true, session
      });
      submission.status = 'approved';
      submission.reviewerNote = String(note || '').trim();
      submission.reviewedAt = new Date();
      submission.createdEventId = event._id;
      submission.localMedia = { photos: [], videos: [] };
      await submission.save({ session });
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { EDITABLE_FIELDS, pick, snapshotEvent, ownsEvent, requestDeletion, approveEventChange };
