import { useState } from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { TitleBar } from './components/TitleBar'
import { TabBar } from './components/TabBar'
import { BottomBar } from './components/BottomBar'
import { StyleSelectOverlay } from './components/StyleSelectOverlay'
import { CharCreateOverlay } from './components/CharCreateOverlay'
import { tabs } from './tabs/registry'

// Import tabs so they self-register
import './tabs/NarrativeTab'
import './tabs/VoicesTab'
import './tabs/DebugTab'

export function App() {
  useWebSocket()
  const [activeTab, setActiveTab] = useState('narrative')

  const ActiveComponent = tabs.find((t) => t.id === activeTab)?.component

  return (
    <div className="app-shell">
      <TitleBar />
      <TabBar activeTab={activeTab} onSelect={setActiveTab} />
      <main className="tab-content">
        {ActiveComponent && <ActiveComponent />}
      </main>
      <BottomBar />
      <StyleSelectOverlay />
      <CharCreateOverlay />
    </div>
  )
}
