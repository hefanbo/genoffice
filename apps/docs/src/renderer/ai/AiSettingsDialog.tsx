import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/locale'
import { useModalKeys } from '../components/modal-keys'
import { AI_PROVIDERS } from '../../shared/ipc'
import type { AiProviderConfig, AiSettings } from '../../shared/ipc'

interface AiSettingsDialogProps {
  /** current settings from the host (fallback while the fresh copy loads) */
  settings: AiSettings
  onClose(): void
  /** the settings the user saved (already persisted via setAiSettings) */
  onSaved(next: AiSettings): void
}

/**
 * In-webview AI model configuration (the VSCode extension has no shell, so this
 * replaces the Electron SettingsModal's Model tab). API keys transiently pass
 * through the webview and are persisted by the host into SecretStorage; the
 * non-secret prefs go into the extension's globalState. Only the active
 * provider's model/baseUrl/protocol are persisted — the current design keeps a
 * single model group, per the product decision.
 */
export function AiSettingsDialog({ settings, onClose, onSaved }: AiSettingsDialogProps) {
  const { t } = useI18n()
  const modalKeys = useModalKeys(onClose)
  const [draft, setDraft] = useState<AiSettings | null>(settings)
  const [saving, setSaving] = useState(false)

  // refresh from the authoritative store on open, so the dialog reflects the
  // persisted state (provider/model/baseUrl/protocol + keys) not a stale prop
  useEffect(() => {
    let alive = true
    void window.desktop.getAiSettings().then((s) => {
      if (alive && s) setDraft(s)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!draft) return null
  const provider = draft.provider
  const meta = AI_PROVIDERS.find((p) => p.id === provider)
  const cfg: AiProviderConfig =
    draft.providers[provider] ?? { apiKey: '', model: meta?.defaultModel ?? '' }
  const isGenspark = provider === 'genspark'

  const patch = (p: Partial<AiProviderConfig>) =>
    setDraft({
      ...draft,
      providers: { ...draft.providers, [provider]: { ...cfg, ...p } },
    })

  const save = async () => {
    setSaving(true)
    try {
      await window.desktop.setAiSettings(draft)
      onSaved(draft)
    } catch (err) {
      console.error('[ai-settings] save failed:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      ref={modalKeys.ref}
      onKeyDown={modalKeys.onKeyDown}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal gs-form">
        <h2>{t('aiSettingsTitle')}</h2>

        <label className="fld">
          {t('aiSettingsProvider')}
          <select
            value={provider}
            onChange={(e) =>
              setDraft({ ...draft, provider: e.target.value as AiSettings['provider'] })
            }
          >
            {AI_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {meta?.needsBaseUrl && (
          <label className="fld">
            {t('aiSettingsProtocol')}
            <select
              value={cfg.protocol ?? 'openai'}
              onChange={(e) => patch({ protocol: e.target.value as 'openai' | 'anthropic' })}
            >
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
        )}

        <label className="fld">
          {t('aiSettingsBaseUrl')}
          <input
            type="text"
            value={cfg.baseUrl ?? ''}
            spellCheck={false}
            placeholder={meta?.needsBaseUrl ? 'https://…/v1' : undefined}
            onChange={(e) => patch({ baseUrl: e.target.value })}
          />
        </label>

        {!isGenspark && (
          <label className="fld">
            {t('aiSettingsApiKey')}
            <input
              type="password"
              value={cfg.apiKey}
              spellCheck={false}
              autoComplete="off"
              placeholder={meta?.keyPlaceholder ?? 'API Key'}
              onChange={(e) => patch({ apiKey: e.target.value })}
            />
          </label>
        )}

        <label className="fld">
          {t('aiSettingsModel')}
          <input
            type="text"
            value={cfg.model}
            spellCheck={false}
            onChange={(e) => patch({ model: e.target.value })}
          />
        </label>

        <div className="modal-actions">
          <button onClick={onClose}>{t('appCancel')}</button>
          <button className="btn-primary" disabled={saving} onClick={() => void save()}>
            {t('appOk')}
          </button>
        </div>
      </div>
    </div>
  )
}
