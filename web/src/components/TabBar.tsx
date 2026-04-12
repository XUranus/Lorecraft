import { tabs, type TabDefinition } from '../tabs/registry'
import { useT } from '../i18n'
import './TabBar.css'

interface Props {
  activeTab: string
  onSelect: (id: string) => void
  items?: TabDefinition[]
}

export function TabBar({ activeTab, onSelect, items }: Props) {
  const t = useT()
  const list = items ?? tabs
  return (
    <nav className="tab-bar">
      {list.map((tab) => (
        <button
          key={tab.id}
          className={`tab-btn ${tab.id === activeTab ? 'active' : ''}`}
          onClick={() => onSelect(tab.id)}
        >
          {t(tab.labelKey)}
        </button>
      ))}
    </nav>
  )
}
