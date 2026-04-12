import { useEffect, useRef } from 'react'
import { useGameStore } from '../stores/useGameStore'
import { registerTab } from './registry'
import './NarrativeTab.css'

function NarrativeTab() {
  const lines = useGameStore((s) => s.narrativeLines)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div className="narrative-tab" ref={containerRef}>
      {lines.map((line, i) =>
        line.cls === 'spacer' ? (
          <div key={i} className="narrative-line spacer" />
        ) : (
          <div key={i} className={`narrative-line ${line.cls}`}>
            {line.text}
          </div>
        ),
      )}
    </div>
  )
}

registerTab({ id: 'narrative', labelKey: 'tab.narrative', component: NarrativeTab })
