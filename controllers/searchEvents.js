const Event = require('../models/Event');
const { buildOccasionQuery } = require('../utils/occasionSearch');
const { PUBLIC_EVENT_SELECT } = require('../utils/publicEvent');

exports.searchEvents = async (req, res) => {
  try {
    const {
      lat,
      lng,
      radius = 20000,
      province,
      city,
      type,
      guests
    } = req.query;

    let query = {
      isActive: { $ne: false },
      $or: [{ 'moderation.status': 'approved' }, { 'moderation.status': { $exists: false } }]
    };

    const occasionQuery = buildOccasionQuery(req.query.occasion);
    if (occasionQuery) query.$and = [occasionQuery];
    if (type) query.type = type;

    if (province) query['location.province'] = province;
    if (city) query['location.city'] = city;

    if (guests) {
      query['capacity.max'] = { $gte: Number(guests) };
    }

    let events;

    // 👉 CON PROXIMIDAD
    if (lat && lng) {
      query['location.coordinates'] = {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [Number(lng), Number(lat)]
          },
          $maxDistance: Number(radius)
        }
      };

      events = await Event.find(query)
        .select(PUBLIC_EVENT_SELECT)
        .sort({ ownerTier: 1 })
        .lean();
    }

    // 👉 SIN PROXIMIDAD
    else {
      events = await Event.find(query)
        .sort({ ownerTier: 1 })
        .lean();
    }

    res.json(events);
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ error: 'Error en búsqueda de eventos' });
  }
};
