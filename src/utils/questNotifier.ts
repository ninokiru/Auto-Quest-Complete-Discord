/**
 * Bridge between the quest store and an operating-system notification.
 *
 * The store owns the completion path but must not import `@/i18n`: that module
 * reads `localStorage` while it is being evaluated, which the store's unit tests
 * do not provide. The page registers a translated announcer instead, so the text
 * is localized while the store still decides what happened to which quest.
 */
type QuestAnnouncer = (questName: string, failedWith?: string) => void

let announcer: QuestAnnouncer | null = null

export function setQuestAnnouncer(next: QuestAnnouncer | null) {
  announcer = next
}

export function announceQuestEnd(questName: string, failedWith?: string) {
  if (!announcer) return
  try {
    announcer(questName, failedWith)
  } catch (error) {
    console.error('Could not raise the quest notification:', error)
  }
}
