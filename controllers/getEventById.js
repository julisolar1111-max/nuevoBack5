const Event = require('../models/Event');
const { PUBLIC_EVENT_SELECT } = require('../utils/publicEvent');

exports.getEventById = async (req, res) => {
  try {
    const { id } = req.params;

    const event = await Event.findOneAndUpdate(
      { _id: id, isActive: { $ne: false }, $or: [{ 'moderation.status': 'approved' }, { 'moderation.status': { $exists: false } }] },
      { $inc: { viewCount: 1 } },
      { new: true }
    ).select(PUBLIC_EVENT_SELECT).lean();

    if (!event) {
      return res.status(404).json({ error: 'Evento no encontrado' });
    }

    res.json(event);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener evento' });
  }
};
