import { getInitialSettings } from '../utils/settings/settings.js'

export function getSpinnerVerbs(): string[] {
  const settings = getInitialSettings()
  const config = settings.spinnerVerbs
  if (!config) {
    return SPINNER_VERBS
  }
  if (config.mode === 'replace') {
    return config.verbs.length > 0 ? config.verbs : SPINNER_VERBS
  }
  return [...SPINNER_VERBS, ...config.verbs]
}

// Spinner verbs for loading messages
export const SPINNER_VERBS = [
  'Arranging Rangoli',
  'Brewing Chai',
  'Lighting Diyas',
  'Painting Mehndi',
  'Playing Tabla',
  'Tuning Sitar',
  'Weaving Khadi',
  'Spinning Charkha',
  'Stringing Gajras',
  'Grinding Masala',
  'Tempering Dal',
  'Rolling Rotis',
  'Stirring Kheer',
  'Decorating Pandals',
  'Flying Patang',
  'Gathering Marigolds',
  'Polishing Brass',
  'Framing Kolam',
  'Preparing Thali',
  'Building DayCode',
]
