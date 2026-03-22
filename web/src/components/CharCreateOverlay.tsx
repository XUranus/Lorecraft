import { useState, useEffect, useCallback } from 'react'
import { useGameStore } from '../stores/useGameStore'
import type { CharCreateState } from '../stores/useGameStore'
import './CharCreateOverlay.css'

const ATTRIBUTE_TOTAL = 400

// ============================================================
// Tier descriptions per attribute
// ============================================================

interface TierDesc {
  label: string
  text: string
}

const TIER_DESCS: Record<string, TierDesc[]> = {
  strength: [
    { label: '孱弱', text: '连沉一点的门都推不动，体力活完全指望不上' },
    { label: '瘦弱', text: '日常生活没问题，但搬重物时会很吃力' },
    { label: '普通', text: '正常成年人的体格，能应付大多数体力需求' },
    { label: '强壮', text: '明显比常人有力，徒手格斗时占据优势' },
    { label: '怪力', text: '力量惊人，可以徒手掰弯铁栏，令人畏惧' },
  ],
  constitution: [
    { label: '病弱', text: '体质极差，稍微奔跑就气喘吁吁，容易生病' },
    { label: '虚弱', text: '耐力不足，长时间活动后需要频繁休息' },
    { label: '健康', text: '体质正常，能承受一般程度的疲劳和伤痛' },
    { label: '强健', text: '精力充沛，能连续作战而不显疲态，恢复力强' },
    { label: '铁躯', text: '近乎超人的耐受力，能扛住常人无法忍受的伤痛' },
  ],
  agility: [
    { label: '笨拙', text: '动作迟缓，手脚不协调，经常绊倒自己' },
    { label: '迟钝', text: '反应比常人慢半拍，精细操作容易出错' },
    { label: '灵活', text: '身手正常，能完成基本的攀爬和闪避' },
    { label: '敏捷', text: '动作迅速流畅，擅长潜行和快速反应' },
    { label: '鬼魅', text: '身法如影，旁人几乎无法捕捉你的动作轨迹' },
  ],
  intelligence: [
    { label: '愚钝', text: '思维缓慢，很难理解复杂的因果关系' },
    { label: '迟缓', text: '能处理简单问题，但复杂推理时力不从心' },
    { label: '聪明', text: '正常的理解和分析能力，能制定合理的计划' },
    { label: '睿智', text: '思维敏锐，善于发现漏洞和隐藏的联系' },
    { label: '天才', text: '惊人的智慧，能在瞬间看穿最复杂的阴谋' },
  ],
  perception: [
    { label: '迟钝', text: '对周围环境几乎没有察觉，经常忽略明显的线索' },
    { label: '粗心', text: '能注意到显而易见的事物，但容易遗漏细节' },
    { label: '警觉', text: '正常的观察力，能注意到大部分异常' },
    { label: '敏锐', text: '目光如炬，善于捕捉微表情和环境中的蛛丝马迹' },
    { label: '洞察', text: '几乎不可能在你面前隐藏任何东西，直觉近乎超自然' },
  ],
  willpower: [
    { label: '软弱', text: '极易屈服于压力，面对威胁时本能地顺从' },
    { label: '动摇', text: '有一定原则，但在高压下容易妥协' },
    { label: '坚定', text: '意志正常，能在一般压力下坚持自己的判断' },
    { label: '刚毅', text: '面对恐吓和诱惑都能岿然不动，精神韧性极强' },
    { label: '不屈', text: '钢铁般的意志，酷刑和精神攻击都无法击溃你' },
  ],
  charisma: [
    { label: '木讷', text: '不善言辞，社交场合总是令人尴尬' },
    { label: '平淡', text: '能正常交流，但很难给人留下深刻印象' },
    { label: '得体', text: '谈吐适当，能在社交中应付自如' },
    { label: '迷人', text: '天生的说服力，容易赢得他人的信任和好感' },
    { label: '倾城', text: '令人无法抗拒的人格魅力，开口即能扭转局面' },
  ],
  luck: [
    { label: '霉运', text: '倒霉似乎是你的天赋，意外总是朝最坏的方向发展' },
    { label: '不顺', text: '运气偏差，关键时刻经常掉链子' },
    { label: '寻常', text: '运气一般，有好有坏，不特别突出' },
    { label: '幸运', text: '关键时刻总能逢凶化吉，巧合常常对你有利' },
    { label: '天眷', text: '仿佛被命运女神亲吻，不可思议的好运一再降临' },
  ],
}

function getTier(value: number): number {
  if (value <= 10) return 0
  if (value <= 30) return 1
  if (value <= 60) return 2
  if (value <= 90) return 3
  return 4
}

function getTierColor(tier: number): string {
  switch (tier) {
    case 0: return 'tier-0'
    case 1: return 'tier-1'
    case 2: return 'tier-2'
    case 3: return 'tier-3'
    case 4: return 'tier-4'
    default: return 'tier-2'
  }
}

// ============================================================
// Components
// ============================================================

export function CharCreateOverlay() {
  const charCreate = useGameStore((s) => s.charCreate)
  const send = useGameStore((s) => s.send)

  if (!charCreate) return null

  return <CharCreatePanel charCreate={charCreate} send={send} />
}

function CharCreatePanel({
  charCreate,
  send,
}: {
  charCreate: CharCreateState
  send: ReturnType<typeof useGameStore.getState>['send']
}) {
  const [attrs, setAttrs] = useState<Record<string, number>>({ ...charCreate.attributes })
  const [error, setError] = useState<string | null>(null)

  // Sync when server sends new random attributes (reroll)
  useEffect(() => {
    setAttrs({ ...charCreate.attributes })
    setError(null)
  }, [charCreate.attributes])

  const total = Object.values(attrs).reduce((a, b) => a + b, 0)
  const remaining = ATTRIBUTE_TOTAL - total

  const setAttr = useCallback((id: string, value: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)))
    setAttrs((prev) => ({ ...prev, [id]: clamped }))
    setError(null)
  }, [])

  function handleReroll() {
    send({ type: 'reroll_attributes' })
  }

  function handleConfirm() {
    const sum = Object.values(attrs).reduce((a, b) => a + b, 0)
    if (sum !== ATTRIBUTE_TOTAL) {
      setError(`属性总和为 ${sum}，需要恰好 ${ATTRIBUTE_TOTAL}`)
      return
    }
    for (const m of charCreate.meta) {
      const v = attrs[m.id]
      if (v === undefined || v < 0 || v > 100 || !Number.isInteger(v)) {
        setError(`${m.display_name} 的值不合法`)
        return
      }
    }
    send({ type: 'confirm_attributes', attributes: attrs })
    useGameStore.getState().setCharCreate(null)
    useGameStore.getState().setInputEnabled(true)
  }

  return (
    <div className="char-create-overlay">
      <div className="char-create-panel">
        <h2 className="char-create-title">角色属性</h2>
        <p className="char-create-subtitle">总点数 {ATTRIBUTE_TOTAL} · 每项 0-100 · 拖动滑块调整</p>

        <div className="attr-list">
          {charCreate.meta.map((m) => (
            <AttrRow
              key={m.id}
              id={m.id}
              displayName={m.display_name}
              value={attrs[m.id] ?? 0}
              onChange={setAttr}
            />
          ))}
        </div>

        <div className={`attr-remaining ${remaining === 0 ? 'ok' : remaining < 0 ? 'over' : 'under'}`}>
          {remaining === 0
            ? '分配完毕'
            : remaining > 0
              ? `剩余 ${remaining} 点`
              : `超出 ${-remaining} 点`}
        </div>

        {error && <div className="char-create-error">{error}</div>}

        <div className="char-create-actions">
          <button className="action-btn secondary" onClick={handleReroll}>
            重新随机
          </button>
          <button
            className="action-btn primary"
            onClick={handleConfirm}
            disabled={remaining !== 0}
          >
            确认开始
          </button>
        </div>
      </div>
    </div>
  )
}

function AttrRow({
  id,
  displayName,
  value,
  onChange,
}: {
  id: string
  displayName: string
  value: number
  onChange: (id: string, v: number) => void
}) {
  const tier = getTier(value)
  const tierDescs = TIER_DESCS[id]
  const desc = tierDescs?.[tier]

  return (
    <div className="attr-row">
      <div className="attr-header">
        <span className="attr-name">{displayName}</span>
        <span className={`attr-tier-label ${getTierColor(tier)}`}>{desc?.label ?? ''}</span>
        <input
          className="attr-input"
          type="number"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(id, parseInt(e.target.value) || 0)}
        />
      </div>
      <div className="attr-slider-row">
        <input
          className={`attr-slider ${getTierColor(tier)}`}
          type="range"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(id, parseInt(e.target.value))}
        />
      </div>
      <div className={`attr-desc ${getTierColor(tier)}`}>{desc?.text ?? ''}</div>
    </div>
  )
}
