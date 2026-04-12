import { useState, useEffect, useRef, useCallback } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { useT } from '../i18n'
import { i18n } from '../i18n'
import { LOCALES, LOCALE_LABELS, LOCALE_TO_LANGUAGE } from '../i18n/locales'
import type { LocaleId } from '../i18n/locales'
import { registerTab } from './registry'
import { PROVIDERS, type ProviderFields, emptyFields, getModelPlaceholder } from '../shared/provider-defs'
import { THEMES } from '../theme/themes'
import { getEngine } from '../engine/bootstrap'
import './SettingsTab.css'

const FONT_SCALE_OPTIONS = [
  { value: 0.85, labelKey: 'settings.fontScale.smaller' },
  { value: 0.9, labelKey: 'settings.fontScale.small' },
  { value: 1, labelKey: 'settings.fontScale.default' },
  { value: 1.1, labelKey: 'settings.fontScale.large' },
  { value: 1.2, labelKey: 'settings.fontScale.larger' },
  { value: 1.35, labelKey: 'settings.fontScale.largest' },
]

function applyFontScale(scale: number) {
  document.documentElement.style.setProperty('--ui-zoom', String(scale))
  const root = document.getElementById('root')
  if (root) root.style.zoom = String(scale)
  localStorage.setItem('lorecraft:font-scale', String(scale))
}

const GAMEPLAY_TOGGLES: Array<{ key: keyof import('../types/protocol').GameplayOptions; labelKey: string; descKey: string; invert?: boolean }> = [
  { key: 'inner_voice', labelKey: 'settings.gameplay.innerVoice', descKey: 'settings.gameplay.innerVoiceDesc' },
  { key: 'insistence', labelKey: 'settings.gameplay.insistence', descKey: 'settings.gameplay.insistenceDesc' },
  { key: 'action_arbiter', labelKey: 'settings.gameplay.actionArbiter', descKey: 'settings.gameplay.actionArbiterDesc' },
  { key: 'narrative_progress', labelKey: 'settings.gameplay.narrativeProgress', descKey: 'settings.gameplay.narrativeProgressDesc' },
  { key: 'world_assertion', labelKey: 'settings.gameplay.worldAssertion', descKey: 'settings.gameplay.worldAssertionDesc', invert: true },
]

function SettingsTab() {
  const t = useT()
  const llmConfig = useGameStore((s) => s.llmConfig)
  const testResult = useGameStore((s) => s.llmTestResult)
  const modelList = useGameStore((s) => s.llmModels)
  const isProcessing = useGameStore((s) => s.isProcessing)
  const send = useGameStore((s) => s.send)
  const gameplayOptions = useGameStore((s) => s.gameplayOptions)
  const debugEnabled = useGameStore((s) => s.debugEnabled)
  const setDebugEnabled = useGameStore((s) => s.setDebugEnabled)
  const theme = useGameStore((s) => s.theme)
  const setTheme = useGameStore((s) => s.setTheme)
  const locale = useGameStore((s) => s.locale)
  const setLocale = useGameStore((s) => s.setLocale)

  const [fontScale, setFontScale] = useState(() => {
    const saved = localStorage.getItem('lorecraft:font-scale')
    return saved ? parseFloat(saved) : 1
  })

  const [provider, setProvider] = useState('gemini')
  const fieldsRef = useRef<Record<string, ProviderFields>>({})
  const [fields, setFields] = useState<ProviderFields>(emptyFields)
  const [testing, setTesting] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [showKey, setShowKey] = useState(false)

  const stashFields = useCallback((prov: string, f: ProviderFields) => {
    fieldsRef.current[prov] = { ...f }
  }, [])

  useEffect(() => { send({ type: 'get_llm_config' }) }, [send])

  useEffect(() => {
    if (llmConfig && llmConfig.provider) {
      const f: ProviderFields = {
        apiKey: llmConfig.api_key, model: llmConfig.model, baseUrl: llmConfig.base_url ?? '',
      }
      fieldsRef.current[llmConfig.provider] = f
      setProvider(llmConfig.provider)
      setFields(f)
    }
  }, [llmConfig])

  useEffect(() => { if (testResult) setTesting(false) }, [testResult])
  useEffect(() => { if (modelList) setLoadingModels(false) }, [modelList])

  const currentProvider = PROVIDERS.find(p => p.value === provider)
  const showBaseUrl = currentProvider?.needsBaseUrl ?? false

  function handleProviderChange(v: string) {
    stashFields(provider, fields)
    setFields(fieldsRef.current[v] ? { ...fieldsRef.current[v] } : { ...emptyFields })
    setProvider(v)
    useGameStore.getState().setLLMModels(null)
    useGameStore.getState().setLLMTestResult(null)
  }

  function updateField(key: keyof ProviderFields, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  function handleTest() {
    setTesting(true)
    useGameStore.getState().setLLMTestResult(null)
    send({
      type: 'test_llm_config', provider, api_key: fields.apiKey, model: fields.model || '',
      ...(showBaseUrl && fields.baseUrl ? { base_url: fields.baseUrl } : {}),
    })
  }

  function handleListModels() {
    setLoadingModels(true)
    useGameStore.getState().setLLMModels(null)
    send({
      type: 'list_models', provider, api_key: fields.apiKey,
      ...(showBaseUrl && fields.baseUrl ? { base_url: fields.baseUrl } : {}),
    })
  }

  function handleSave() {
    stashFields(provider, fields)
    send({
      type: 'set_llm_config', provider, api_key: fields.apiKey, model: fields.model,
      ...(showBaseUrl && fields.baseUrl ? { base_url: fields.baseUrl } : {}),
    })
  }

  function handleLocaleChange(l: LocaleId) {
    setLocale(l)
    i18n.changeLanguage(l)
    // Sync engine language
    const engine = getEngine()
    if (engine) engine.setLanguage(LOCALE_TO_LANGUAGE[l])
  }

  const hasKey = fields.apiKey.trim().length > 0
  const canSave = hasKey && !isProcessing
  const canTest = hasKey && !isProcessing

  return (
    <div className="settings-tab">
      <div className="settings-section">
        <div className="settings-section-title">{t('settings.llmConfig')}</div>

        {isProcessing && (
          <div className="settings-warn">{t('settings.processingWarn')}</div>
        )}

        <div className="settings-field">
          <span className="settings-field-label">{t('settings.provider')}</span>
          <select className="settings-select" value={provider} onChange={(e) => handleProviderChange(e.target.value)} disabled={isProcessing}>
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        {showBaseUrl && (
          <div className="settings-field">
            <span className="settings-field-label">{t('settings.apiUrl')}</span>
            <input className="settings-input" type="text" value={fields.baseUrl}
              onChange={(e) => updateField('baseUrl', e.target.value)}
              placeholder={currentProvider?.baseUrlPlaceholder ?? 'https://api.example.com/v1'}
              disabled={isProcessing} />
            <span className="settings-hint">{currentProvider?.baseUrlHint ?? ''}</span>
          </div>
        )}

        <div className="settings-field">
          <span className="settings-field-label">{t('settings.apiKey')}</span>
          <div className="settings-key-row">
            <input className="settings-input settings-key-input"
              type={showKey ? 'text' : 'password'} value={fields.apiKey}
              onChange={(e) => updateField('apiKey', e.target.value)}
              placeholder={currentProvider?.keyPlaceholder ?? 'sk-...'}
              disabled={isProcessing} />
            <button className="settings-eye-btn" type="button" onClick={() => setShowKey(!showKey)}
              title={showKey ? t('settings.hideKey') : t('settings.showKey')}>
              {showKey ? '\u25C9' : '\u25CE'}
            </button>
          </div>
        </div>

        <div className="settings-field">
          <span className="settings-field-label">{t('settings.model')}</span>
          <div className="settings-model-row">
            {modelList && modelList.length > 0 ? (
              <select className="settings-select settings-model-select" value={fields.model}
                onChange={(e) => updateField('model', e.target.value)} disabled={isProcessing}>
                <option value="">{t('settings.defaultModel')}</option>
                {modelList.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input className="settings-input settings-model-input" type="text" value={fields.model}
                onChange={(e) => updateField('model', e.target.value)}
                placeholder={getModelPlaceholder(provider)} disabled={isProcessing} />
            )}
            <button className="settings-fetch-btn" disabled={!canTest || loadingModels} onClick={handleListModels}>
              {loadingModels ? '...' : t('settings.fetchModels')}
            </button>
          </div>
        </div>

        <div className="settings-actions">
          <button className="settings-test-btn" disabled={!canTest || testing} onClick={handleTest}>
            {testing ? t('settings.testing') : t('settings.testConnection')}
          </button>
          <button className="settings-save-btn" disabled={!canSave} onClick={handleSave}>
            {t('settings.saveApply')}
          </button>
        </div>

        {testResult && (
          <div className={`settings-test-result ${testResult.success ? 'success' : 'fail'}`}>
            {testResult.success ? t('settings.connectSuccess') : t('settings.connectFail', { message: testResult.message })}
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{t('settings.theme')}</div>
        <div className="theme-cards">
          {THEMES.map((tm) => (
            <button
              key={tm.id}
              type="button"
              className={`theme-card ${theme === tm.id ? 'active' : ''}`}
              onClick={() => setTheme(tm.id)}
            >
              <div className="theme-card-swatches">
                <span className="theme-swatch" style={{ background: tm.swatch.bg }} />
                <span className="theme-swatch" style={{ background: tm.swatch.accent }} />
                <span className="theme-swatch" style={{ background: tm.swatch.fg }} />
              </div>
              <div className="theme-card-name">{t(`theme.${tm.id}.label`)}</div>
              <div className="theme-card-desc">{t(`theme.${tm.id}.description`)}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{t('settings.display')}</div>
        <div className="settings-field">
          <span className="settings-field-label">{t('settings.uiZoom')}</span>
          <div className="font-scale-row">
            {FONT_SCALE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`font-scale-btn ${fontScale === opt.value ? 'active' : ''}`}
                onClick={() => { setFontScale(opt.value); applyFontScale(opt.value) }}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>
        <label className="gameplay-toggle">
            <div className="gameplay-toggle-text">
              <span className="gameplay-toggle-label">{t('settings.debugPanel')}</span>
              <span className="gameplay-toggle-desc">{t('settings.debugPanelDesc')}</span>
            </div>
            <input
              type="checkbox"
              className="gameplay-toggle-input"
              checked={debugEnabled}
              onChange={(e) => setDebugEnabled(e.target.checked)}
            />
          </label>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{t('settings.gameOptions')}</div>
        <div className="gameplay-toggles">
          {GAMEPLAY_TOGGLES.map((tg) => {
            const disabled = tg.key === 'insistence' && !gameplayOptions.inner_voice
            const rawVal = disabled ? false : gameplayOptions[tg.key]
            const checked = tg.invert ? !rawVal : rawVal
            return (
              <label key={tg.key} className={`gameplay-toggle ${disabled ? 'disabled' : ''}`}>
                <div className="gameplay-toggle-text">
                  <span className="gameplay-toggle-label">{t(tg.labelKey)}</span>
                  <span className="gameplay-toggle-desc">{t(tg.descKey)}</span>
                </div>
                <input
                  type="checkbox"
                  className="gameplay-toggle-input"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => {
                    const newVal = tg.invert ? !e.target.checked : e.target.checked
                    const updates: Record<string, boolean> = { [tg.key]: newVal }
                    if (tg.key === 'inner_voice' && !newVal) {
                      updates.insistence = false
                    }
                    send({ type: 'set_gameplay_options', options: updates })
                  }}
                />
              </label>
            )
          })}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{t('ui:settings.language', { defaultValue: 'Language' })}</div>
        <div className="font-scale-row">
          {LOCALES.map((l) => (
            <button
              key={l}
              className={`font-scale-btn ${locale === l ? 'active' : ''}`}
              onClick={() => handleLocaleChange(l)}
            >
              {LOCALE_LABELS[l]}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-build-info">
        <span className="build-brand">Lorecraft</span>
        <span className="build-sep">·</span>
        <span>v{__BUILD_VERSION__}</span>
        <span className="build-sep">·</span>
        <span>{__GIT_HASH__ === 'dev' ? 'dev' : __GIT_HASH__.slice(0, 7)}</span>
        <span className="build-sep">·</span>
        <span>{new Date(__BUILD_TIME__).toLocaleString()}</span>
      </div>
    </div>
  )
}

registerTab({ id: 'settings', labelKey: 'tab.settings', component: SettingsTab })
