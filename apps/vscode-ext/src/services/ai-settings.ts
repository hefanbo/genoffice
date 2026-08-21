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
// Non-secret prefs live in the extension's own storage (globalState), never in
// vscode settings.json — the extension contributes no genoffice.ai.* settings,
// so the Settings UI stays clean and the AI config is edited only via the
// in-webview dialog.
const PREF_PROVIDER = 'genoffice.ai.provider'
const PREF_MODEL = 'genoffice.ai.model'
const PREF_BASE_URL = 'genoffice.ai.baseUrl'
const PREF_PROTOCOL = 'genoffice.ai.protocol'

/**
 * BYOK settings: API keys live in SecretStorage (never in configuration or the
 * webview), non-secret prefs (provider/model/baseUrl/protocol) live in the
 * extension's globalState.
 */
export class AiSettingsStore {
  private readonly secrets: vscode.SecretStorage
  private readonly state: vscode.Memento

  constructor(context: vscode.ExtensionContext) {
    this.secrets = context.secrets
    this.state = context.globalState
  }

  async get(): Promise<AiSettings> {
    const keys: Partial<Record<AiProviderId, string>> = {}
    for (const id of PROVIDER_IDS) {
      const key = await this.secrets.get(KEY_PREFIX + id)
      if (key) keys[id] = key
    }
    const settings = defaultAiSettings(keys)

    const provider = this.state.get<string>(PREF_PROVIDER) as AiProviderId | undefined
    if (provider && settings.providers[provider]) settings.provider = provider

    const model = this.state.get<string>(PREF_MODEL)
    if (model) settings.providers[settings.provider].model = model

    const baseUrl = this.state.get<string>(PREF_BASE_URL)
    if (baseUrl) settings.providers[settings.provider].baseUrl = baseUrl

    const protocol = this.state.get<'openai' | 'anthropic'>(PREF_PROTOCOL)
    if (protocol) settings.providers[settings.provider].protocol = protocol

    return settings
  }

  async set(settings: AiSettings): Promise<void> {
    for (const id of PROVIDER_IDS) {
      const key = settings.providers?.[id]?.apiKey
      if (key) await this.secrets.store(KEY_PREFIX + id, key)
      else await this.secrets.delete(KEY_PREFIX + id)
    }
    await this.state.update(PREF_PROVIDER, settings.provider)
    const cfg = settings.providers?.[settings.provider]
    if (cfg) {
      await this.state.update(PREF_MODEL, cfg.model || '')
      if (cfg.baseUrl !== undefined) await this.state.update(PREF_BASE_URL, cfg.baseUrl)
      if (cfg.protocol !== undefined) await this.state.update(PREF_PROTOCOL, cfg.protocol)
    }
  }
}
