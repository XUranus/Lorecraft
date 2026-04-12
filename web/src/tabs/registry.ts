import type { ComponentType } from 'react'

export interface TabDefinition {
  id: string
  /** i18n key under ui namespace, e.g. 'tab.narrative' */
  labelKey: string

  component: ComponentType
}

export const tabs: TabDefinition[] = []

export function registerTab(tab: TabDefinition) {
  tabs.push(tab)
}
