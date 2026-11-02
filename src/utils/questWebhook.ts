import { sendQuestWebhook, type WebhookConfig } from '@/api/webhook'

const STORAGE_KEY = 'questHelper_webhookConfig'

export function defaultWebhookConfig(): WebhookConfig {
  return { enabled: false, url: '', bearerToken: '', onComplete: true, onFailure: true }
}

export function loadWebhookConfig(): WebhookConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultWebhookConfig()
    const parsed = JSON.parse(raw) as Partial<WebhookConfig>
    return { ...defaultWebhookConfig(), ...parsed }
  } catch {
    return defaultWebhookConfig()
  }
}

export function saveWebhookConfig(config: WebhookConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

/** Fire-and-forget; failures stay in the console so a webhook never blocks a quest. */
export function notifyQuestWebhook(
  event: 'quest_completed' | 'quest_failed',
  questId: string,
  name: string,
  error?: string,
): void {
  const config = loadWebhookConfig()
  if (!config.enabled) return
  const wanted = event === 'quest_completed' ? config.onComplete : config.onFailure
  if (!wanted) return
  sendQuestWebhook(config, event, questId, name, error ?? null).catch((failure) => {
    console.error('Quest webhook delivery failed:', failure)
  })
}
