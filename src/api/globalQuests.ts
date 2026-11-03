import { liveGlobalQuests, parseGlobalQuests, type GlobalQuest } from '@/utils/globalQuests'

const CATALOG_URL = 'https://api.discordquest.com/api/quests'
export const GLOBAL_QUEST_TIMEOUT_MS = 20_000

export async function fetchGlobalQuestCatalog(): Promise<GlobalQuest[]> {
  const controller = new AbortController()
  // Without a deadline a stalled DNS lookup or CDN keeps the tab on its skeleton forever.
  const timeout = setTimeout(() => controller.abort(), GLOBAL_QUEST_TIMEOUT_MS)
  try {
    const response = await fetch(CATALOG_URL, {
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return liveGlobalQuests(parseGlobalQuests(await response.json()), Date.now())
  } finally {
    clearTimeout(timeout)
  }
}
