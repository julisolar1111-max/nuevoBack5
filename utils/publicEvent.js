// Allowlist shared by public queries. Owner identity and moderation are never public.
const PUBLIC_EVENT_FIELDS = [
  '_id', 'name', 'slug', 'publicPath', 'type', 'eventType', 'partyTypes',
  'ownerTier', 'featured', 'createdAt', 'updatedAt', 'capacity', 'priceRange',
  'pricing', 'plans', 'location', 'media', 'description', 'contactInfo',
  'preferredContactMethod'
];
const PUBLIC_EVENT_SELECT = PUBLIC_EVENT_FIELDS.join(' ');
const PUBLIC_EVENT_PROJECTION = Object.fromEntries(PUBLIC_EVENT_FIELDS.map(field => [field, 1]));

module.exports = { PUBLIC_EVENT_FIELDS, PUBLIC_EVENT_SELECT, PUBLIC_EVENT_PROJECTION };
