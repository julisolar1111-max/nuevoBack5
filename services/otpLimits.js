const crypto = require('crypto');
const OtpRateLimit = require('../models/OtpRateLimit');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

// Persisted counters are shared by server instances. Never trust a raw forwarded header.
const createLimiter = (store, now = Date.now) => (kind) => async (req, res, next) => {
  try {
    const time = now();
    const bucket = Math.floor(time / WINDOW_MS);
    const expiresAt = new Date((bucket + 1) * WINDOW_MS);
    const ipHash = crypto.createHash('sha256').update(req.ip || req.socket?.remoteAddress || 'unknown').digest('hex');
    const id = `${kind}:${ipHash}:${bucket}`;
    let counter;
    try {
      counter = await store.findOneAndUpdate({ _id: id }, {
        $inc: { count: 1 }, $setOnInsert: { expiresAt }
      }, { upsert: true, new: true });
    } catch (error) {
      if (error.code !== 11000) throw error;
      counter = await store.findOneAndUpdate({ _id: id }, { $inc: { count: 1 } }, { new: true });
    }
    if (counter.count > MAX_ATTEMPTS) {
      const retryAfter = Math.max(1, Math.ceil((expiresAt.getTime() - time) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        message: `Alcanzaste el limite de 3 ${kind === 'send' ? 'envios de codigo' : 'intentos de verificacion'} por IP. Espera ${Math.ceil(retryAfter / 60)} minutos para volver a intentar.`,
        retryAfter
      });
    }
    return next();
  } catch {
    return res.status(503).json({ message: 'No pudimos verificar el limite de intentos. Intenta mas tarde.' });
  }
};

module.exports = { limitOtpAttempts: createLimiter(OtpRateLimit), createLimiter };
