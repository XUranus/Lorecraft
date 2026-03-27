import { useState, useEffect, useRef, useCallback } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { registerTab } from './registry'
import { PROVIDERS, type ProviderFields, emptyFields, getModelPlaceholder } from '../shared/provider-defs'
import './SettingsTab.css'

function SettingsTab() {
  const llmConfig = useGameStore((s) => s.llmConfig)
  const testResult = useGameStore((s) => s.llmTestResult)
  const modelList = useGameStore((s) => s.llmModels)
  const isProcessing = useGameStore((s) => s.isProcessing)
  const send = useGameStore((s) => s.send)

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

  const hasKey = fields.apiKey.trim().length > 0
  const canSave = hasKey && !isProcessing
  const canTest = hasKey && !isProcessing

  return (
    <div className="settings-tab">
      <div className="settings-section">
        <div className="settings-section-title">大模型配置</div>

        {isProcessing && (
          <div className="settings-warn">回合进行中，无法修改配置</div>
        )}

        <div className="settings-field">
          <span className="settings-field-label">服务商</span>
          <select className="settings-select" value={provider} onChange={(e) => handleProviderChange(e.target.value)} disabled={isProcessing}>
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        {showBaseUrl && (
          <div className="settings-field">
            <span className="settings-field-label">API 地址</span>
            <input className="settings-input" type="text" value={fields.baseUrl}
              onChange={(e) => updateField('baseUrl', e.target.value)}
              placeholder={currentProvider?.baseUrlPlaceholder ?? 'https://api.example.com/v1'}
              disabled={isProcessing} />
            <span className="settings-hint">{currentProvider?.baseUrlHint ?? ''}</span>
          </div>
        )}

        <div className="settings-field">
          <span className="settings-field-label">API Key</span>
          <div className="settings-key-row">
            <input className="settings-input settings-key-input"
              type={showKey ? 'text' : 'password'} value={fields.apiKey}
              onChange={(e) => updateField('apiKey', e.target.value)}
              placeholder={currentProvider?.keyPlaceholder ?? 'sk-...'}
              disabled={isProcessing} />
            <button className="settings-eye-btn" type="button" onClick={() => setShowKey(!showKey)}
              title={showKey ? '隐藏' : '显示'}>
              {showKey ? '\u25C9' : '\u25CE'}
            </button>
          </div>
        </div>

        <div className="settings-field">
          <span className="settings-field-label">模型</span>
          <div className="settings-model-row">
            {modelList && modelList.length > 0 ? (
              <select className="settings-select settings-model-select" value={fields.model}
                onChange={(e) => updateField('model', e.target.value)} disabled={isProcessing}>
                <option value="">默认模型</option>
                {modelList.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input className="settings-input settings-model-input" type="text" value={fields.model}
                onChange={(e) => updateField('model', e.target.value)}
                placeholder={getModelPlaceholder(provider)} disabled={isProcessing} />
            )}
            <button className="settings-fetch-btn" disabled={!canTest || loadingModels} onClick={handleListModels}>
              {loadingModels ? '...' : '获取列表'}
            </button>
          </div>
        </div>

        <div className="settings-actions">
          <button className="settings-test-btn" disabled={!canTest || testing} onClick={handleTest}>
            {testing ? '测试中...' : '测试连接'}
          </button>
          <button className="settings-save-btn" disabled={!canSave} onClick={handleSave}>
            保存并应用
          </button>
        </div>

        {testResult && (
          <div className={`settings-test-result ${testResult.success ? 'success' : 'fail'}`}>
            {testResult.success ? '连接成功' : `连接失败: ${testResult.message}`}
          </div>
        )}
      </div>
    </div>
  )
}

registerTab({ id: 'settings', label: '设置', component: SettingsTab })
