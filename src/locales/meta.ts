export const supportedLocales = [
  { code: 'en', label: 'English' },
  { code: 'vi', label: 'Tiếng Việt' },
] as const

export type SupportedLocale = (typeof supportedLocales)[number]['code']
