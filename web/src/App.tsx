import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useEngine } from './hooks/useEngine'
import { useGameStore } from './stores/useGameStore'
import { TitleBar } from './components/TitleBar'
import { TabBar } from './components/TabBar'
import { BottomBar } from './components/BottomBar'
import { StyleSelectOverlay } from './components/StyleSelectOverlay'
import { CharCreateOverlay } from './components/CharCreateOverlay'
import { SessionOverlay } from './components/SessionOverlay'
import { tabs } from './tabs/registry'

// Import tabs so they self-register
import './tabs/NarrativeTab'
import './tabs/CharactersTab'
import './tabs/QuestTab'
import './tabs/DebugTab'
import './tabs/SettingsTab'

function useIsDesktop(breakpoint = 860) {
  const [desktop, setDesktop] = useState(window.innerWidth >= breakpoint)
  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${breakpoint}px)`)
    const handler = (e: MediaQueryListEvent) => setDesktop(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [breakpoint])
  return desktop
}

const RIGHT_MIN = 280
const RIGHT_MAX = 700
const RIGHT_DEFAULT = 400

function useResizable() {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('lorecraft:side-width')
    const w = saved ? parseInt(saved, 10) : RIGHT_DEFAULT
    return Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, w))
  })
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true
    startX.current = e.clientX
    startW.current = width
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [width])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return
    // Dragging left = making right panel wider
    const delta = startX.current - e.clientX
    const next = Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, startW.current + delta))
    setWidth(next)
  }, [])

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    localStorage.setItem('lorecraft:side-width', String(width))
  }, [width])

  return { width, onPointerDown, onPointerMove, onPointerUp }
}

export function App() {
  useEngine()
  const isDesktop = useIsDesktop()
  const resizable = useResizable()

  const debugEnabled = useGameStore((s) => s.debugEnabled)

  const [mobileTab, setMobileTab] = useState('narrative')
  const [sideTab, setSideTab] = useState('characters')

  const NarrativeComp = useMemo(() => tabs.find(t => t.id === 'narrative')?.component, [])
  const visibleTabs = useMemo(
    () => tabs.filter(t => t.id !== 'debug' || debugEnabled),
    [debugEnabled],
  )
  const sideTabs = useMemo(
    () => visibleTabs.filter(t => t.id !== 'narrative'),
    [visibleTabs],
  )
  const SideComp = sideTabs.find(t => t.id === sideTab)?.component
  const MobileComp = visibleTabs.find(t => t.id === mobileTab)?.component

  return (
    <div className="app-shell">
      <div className="atmosphere" />
      <TitleBar />
      {isDesktop ? (
        <div className="desktop-body">
          <div className="desktop-left">
            <main className="tab-content">
              {NarrativeComp && <NarrativeComp />}
            </main>
            <BottomBar />
          </div>
          <div
            className="desktop-divider"
            onPointerDown={resizable.onPointerDown}
            onPointerMove={resizable.onPointerMove}
            onPointerUp={resizable.onPointerUp}
          />
          <div className="desktop-right" style={{ width: resizable.width }}>
            <TabBar activeTab={sideTab} onSelect={setSideTab} items={sideTabs} />
            <main className="tab-content">
              {SideComp && <SideComp />}
            </main>
          </div>
        </div>
      ) : (
        <>
          <TabBar activeTab={mobileTab} onSelect={setMobileTab} items={visibleTabs} />
          <main className="tab-content">
            {MobileComp && <MobileComp />}
          </main>
          <BottomBar />
        </>
      )}
      <StyleSelectOverlay />
      <CharCreateOverlay />
      <SessionOverlay />
    </div>
  )
}
