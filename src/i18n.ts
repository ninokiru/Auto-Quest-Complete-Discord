import { createI18n } from 'vue-i18n'
import en from './locales/en.json'
import vi from './locales/vi.json'

// Detect default locale based on browser settings
function getDefaultLocale(): string {
    const normalizeLocale = (raw: string): string =>
        raw.toLowerCase().startsWith('vi') ? 'vi' : 'en'

    const saved = localStorage.getItem('locale') ?? localStorage.getItem('language')
    if (saved) return normalizeLocale(saved)

    return normalizeLocale(navigator.language)
}

const i18n = createI18n({
    legacy: false, // Use Composition API mode
    locale: getDefaultLocale(),
    fallbackLocale: 'en',
    messages: {
        en,
        vi
    }
})

export default i18n
