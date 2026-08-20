import * as vscode from 'vscode'
import { defaultAiSettings } from '@genoffice/ai-provider'
import type { AiProviderId, AiSettings } from '@genoffice/ai-provider'

const PROVIDER_IDS: AiProviderId[] = [
  'genspark',
  'anthropic',
  'gemini',
  'deepseek',
  'openai',
  'custom',
]
const KEY_PREFIX = 'genoffice.ai.key.'

/**
 * BYOK settings: API keys live in SecretStorage (never in configuration or the
 * webview), non-secret prefs (provider/model/baseUrl) live in configuration.
 */
export class AiSettingsStore {
  private config = vscode.workspace.getConfiguration('genoffice.ai')

  constructor(private secrets: vscode.SecretStorage) {}

  async get(): Promise<AiSettings> {
    const keys: Partial<Record<AiProviderId, string>> = {}
    for (const id of PROVIDER_IDS) {
      const key = await this.secrets.get(KEY_PREFIX + id)
      if (key) keys[id] = key
    }
    const settings = defaultAiSettings(keys)

    const provider = this.config.get<string>('provider') as AiProviderId | undefined
    if (provider && settings.providers[provider]) settings.provider = provider

    const model = this.config.get<string>('model')
    if (model) settings.providers[settings.provider].model = model

    const baseUrl = this.config.get<string>('baseUrl')
    if (baseUrl) settings.providers[settings.provider].baseUrl = baseUrl

    return settings
  }

  async set(settings: AiSettings): Promise<void> {
    for (const id of PROVIDER_IDS) {
      const key = settings.providers?.[id]?.apiKey
      if (key) await this.secrets.store(KEY_PREFIX + id, key)
      else await this.secrets.delete(KEY_PREFIX + id)
    }
    await this.config.update('provider', settings.provider, vscode.ConfigurationTarget.Global)
    const cfg = settings.providers?.[settings.provider]
    if (cfg) {
      await this.config.update('model', cfg.model || '', vscode.ConfigurationTarget.Global)
      if (cfg.baseUrl !== undefined) {
        await this.config.update('baseUrl', cfg.baseUrl, vscode.ConfigurationTarget.Global)
      }
    }
  }
}
