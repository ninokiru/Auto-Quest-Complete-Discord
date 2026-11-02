import { invoke } from '@tauri-apps/api/core'

export interface WebhookConfig {
  enabled: boolean
  url: string
  bearerToken: string
  onComplete: boolean
  onFailure: boolean
}

export async function sendQuestWebhook(
  config: WebhookConfig,
  event: 'quest_completed' | 'quest_failed' | 'test',
  questId?: string | null,
  name?: string | null,
  error?: string | null,
): Promise<void> {
  await invoke('send_quest_webhook', { config, event, questId, name, error })
}

export async function testQuestWebhook(config: WebhookConfig): Promise<void> {
  await invoke('test_quest_webhook', { config })
}
