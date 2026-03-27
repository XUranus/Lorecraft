import { tabs, type TabDefinition } from '../tabs/registry'
import './TabBar.css'

interface Props {
  activeTab: string
  onSelect: (id: string) => void
  items?: TabDefinition[]
}

export function TabBar({ activeTab, onSelect, items }: Props) {
  const list = items ?? tabs
  return (
    <nav className="tab-bar">
      {list.map((t) => (
        <button
          key={t.id}
          className={`tab-btn ${t.id === activeTab ? 'active' : ''}`}
          onClick={() => onSelect(t.id)}
        >
          {t.icon && <span className="tab-icon">{t.icon}</span>}
          {t.label}
        </button>
      ))}
    </nav>
  )
}
