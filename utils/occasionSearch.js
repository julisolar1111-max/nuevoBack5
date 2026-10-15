const OCCASIONS = {
  cumpleanios: ['cumpleaños', 'cumpleanos', 'cumpleanios', 'cumpleaños-infantil', 'cumpleanos-infantil', 'cumpleanios-infantil'],
  'cumpleanios-infantil': ['cumpleaños-infantil', 'cumpleanos-infantil', 'cumpleanios-infantil'],
  casamiento: ['boda', 'casamiento', 'casamientos'],
  xv: ['quinceaños', 'quinceanos', 'quinceanios', 'xv', '15 años', '15 anos'],
  empresarial: ['empresarial', 'corporativo'],
  egresados: ['egresados', 'egresado', 'graduacion', 'graduación'],
  otro: ['otro', 'despedida', 'asado', 'reunion', 'reunión']
};

function buildOccasionQuery(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return null;
  if (!Object.hasOwn(OCCASIONS, key)) throw Object.assign(new Error('Ocasion invalida'), { status: 400 });
  const values = OCCASIONS[key].map(item => new RegExp(`^${item}$`, 'i'));
  // A schema default of "otro" alone does not prove that a venue was classified.
  const legacyValues = key === 'otro' ? values.filter((_, index) => OCCASIONS[key][index] !== 'otro') : values;
  return { $or: [
    { partyTypes: { $in: values } },
    { eventType: { $in: legacyValues } }
  ] };
}

module.exports = { buildOccasionQuery, OCCASIONS };
