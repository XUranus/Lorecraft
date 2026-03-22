import type { InsistenceState } from '../models/pipeline-io.js'

export class InsistenceStateMachine {
  private state: InsistenceState = 'NORMAL'
  private forceLevel: 0 | 1 | 2 = 0
  private storedIntentHash: string | null = null

  /**
   * Returns the current insistence state: NORMAL, WARNED, or INSISTING.
   */
  getState(): InsistenceState {
    return this.state
  }

  /**
   * Returns the current force level:
   * - 0: no force (NORMAL or WARNED)
   * - 1: player repeated the same intent
   * - 2: player explicitly insisted
   */
  getForceLevel(): 0 | 1 | 2 {
    return this.forceLevel
  }

  /**
   * Called when the reflection pipeline emits a block (warning the player).
   * Transitions from NORMAL to WARNED and stores the intent hash for comparison.
   */
  onReflectionBlock(intent_hash: string): void {
    if (this.state === 'NORMAL') {
      this.state = 'WARNED'
      this.storedIntentHash = intent_hash
      this.forceLevel = 0
    }
  }

  /**
   * Called when the player submits new input after a reflection block.
   *
   * - In WARNED state with the same intent hash: transitions to INSISTING (force_level=1).
   * - In WARNED state with explicit insistence (detected by caller, pass `explicitInsistence=true`):
   *   transitions to INSISTING (force_level=2).
   * - In WARNED state with a different intent: resets to NORMAL.
   * - In other states: no-op.
   */
  onPlayerInput(intent_hash: string, explicitInsistence: boolean = false): void {
    if (this.state !== 'WARNED') return

    if (explicitInsistence) {
      this.state = 'INSISTING'
      this.forceLevel = 2
      return
    }

    if (intent_hash === this.storedIntentHash) {
      this.state = 'INSISTING'
      this.forceLevel = 1
      return
    }

    // Different intent — the player changed their mind
    this.state = 'NORMAL'
    this.forceLevel = 0
    this.storedIntentHash = null
  }

  /**
   * Resets the state machine back to NORMAL after a pipeline completes.
   */
  reset(): void {
    this.state = 'NORMAL'
    this.forceLevel = 0
    this.storedIntentHash = null
  }
}
