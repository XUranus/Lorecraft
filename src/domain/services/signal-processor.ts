import type { IStateStore } from '../../infrastructure/storage/interfaces.js'
import type { TraitConfig, TraitWeight, WeightUpdateLog } from '../models/trait.js'
import type { ToneSignals } from '../models/pipeline-io.js'
import type { TraitStatus } from '../models/common.js'

const SIGNAL_B_STRENGTH_MULTIPLIER = 1.5

const TRAIT_KEY_PREFIX = 'player:traits:'

export class SignalProcessor {
  private readonly store: IStateStore
  private readonly configMap: Map<string, TraitConfig>
  private readonly updateLog: WeightUpdateLog[] = []

  constructor(store: IStateStore, configs: TraitConfig[]) {
    this.store = store
    this.configMap = new Map(configs.map((c) => [c.trait_id, c]))
  }

  /**
   * Returns traits whose computed status is ACTIVE or EMERGING.
   */
  async getActiveTraits(): Promise<TraitWeight[]> {
    const results: TraitWeight[] = []

    for (const config of this.configMap.values()) {
      const weight = await this.loadWeight(config.trait_id)
      if (!weight) continue

      const status = this.computeStatus(weight.current_weight, config)
      if (status === 'ACTIVE' || status === 'EMERGING') {
        results.push(weight)
      }
    }

    return results
  }

  /**
   * Computes the current status of a trait from its weight and config thresholds.
   * Returns SILENT, EMERGING, ACTIVE, or FADING.
   */
  async getTraitStatus(trait_id: string): Promise<TraitStatus> {
    const config = this.configMap.get(trait_id)
    if (!config) {
      return 'SILENT'
    }

    const weight = await this.loadWeight(trait_id)
    if (!weight) {
      return 'SILENT'
    }

    return this.computeStatus(weight.current_weight, config)
  }

  /**
   * Applies tone signals (Signal A) to all configured traits via their signal_mapping.
   * Each tone key is multiplied by the mapping coefficient to produce a weight delta.
   */
  async applySignalA(tone_signals: ToneSignals): Promise<void> {
    for (const config of this.configMap.values()) {
      let delta = 0
      for (const [toneKey, toneValue] of Object.entries(tone_signals)) {
        const coeff = config.signal_mapping[toneKey] ?? 0
        delta += toneValue * coeff
      }

      if (delta !== 0) {
        await this.updateWeight(config.trait_id, delta, 'A')
      }
    }
  }

  /**
   * Applies choice signals (Signal B) to traits. Each signal value is scaled by
   * SIGNAL_B_STRENGTH_MULTIPLIER (1.5) and applied as a direct weight delta.
   */
  async applySignalB(choice_signals: Record<string, number>): Promise<void> {
    for (const [traitId, signalValue] of Object.entries(choice_signals)) {
      const delta = signalValue * SIGNAL_B_STRENGTH_MULTIPLIER
      if (delta !== 0) {
        await this.updateWeight(traitId, delta, 'B')
      }
    }
  }

  /**
   * Applies exponential decay to all trait weights based on turns elapsed since
   * last update: `weight * decay_rate ^ turns_elapsed`.
   */
  async decayAllWeights(current_turn: number): Promise<void> {
    for (const config of this.configMap.values()) {
      const weight = await this.loadWeight(config.trait_id)
      if (!weight || weight.current_weight === 0) continue

      const turnsSinceUpdate = current_turn - weight.last_updated_turn
      if (turnsSinceUpdate <= 0) continue

      const decayedWeight = weight.current_weight * Math.pow(config.decay_rate, turnsSinceUpdate)
      const newWeight = Math.max(0, decayedWeight)
      const delta = newWeight - weight.current_weight

      this.updateLog.push({
        trait_id: config.trait_id,
        delta,
        signal_type: 'DECAY',
        source_event_id: null,
        before_weight: weight.current_weight,
        after_weight: newWeight,
        turn: current_turn,
      })

      await this.store.set<TraitWeight>(TRAIT_KEY_PREFIX + config.trait_id, {
        ...weight,
        current_weight: newWeight,
        last_updated_turn: current_turn,
      })
    }
  }

  /**
   * Returns the accumulated weight update log entries for debugging.
   */
  getUpdateLog(): readonly WeightUpdateLog[] {
    return this.updateLog
  }

  /**
   * Clears all accumulated log entries.
   */
  clearUpdateLog(): void {
    this.updateLog.length = 0
  }

  // ── Internal ──────────────────────────────────────────────

  private computeStatus(currentWeight: number, config: TraitConfig): TraitStatus {
    if (currentWeight >= config.threshold_active) return 'ACTIVE'
    if (currentWeight >= config.threshold_active - config.hysteresis_band) return 'EMERGING'
    if (currentWeight >= config.threshold_silent + config.hysteresis_band) return 'FADING'
    return 'SILENT'
  }

  private async loadWeight(trait_id: string): Promise<TraitWeight | null> {
    return this.store.get<TraitWeight>(TRAIT_KEY_PREFIX + trait_id)
  }

  private async updateWeight(
    trait_id: string,
    delta: number,
    signal_type: 'A' | 'B',
  ): Promise<void> {
    const existing = await this.loadWeight(trait_id)
    const config = this.configMap.get(trait_id)

    const beforeWeight = existing?.current_weight ?? 0
    const newWeight = Math.max(0, beforeWeight + delta)

    const updated: TraitWeight = {
      trait_id,
      trait_type: config?.trait_type ?? existing?.trait_type ?? 'EXPRESSION',
      current_weight: newWeight,
      last_updated_turn: existing?.last_updated_turn ?? 0,
    }

    this.updateLog.push({
      trait_id,
      delta,
      signal_type,
      source_event_id: null,
      before_weight: beforeWeight,
      after_weight: newWeight,
      turn: updated.last_updated_turn,
    })

    await this.store.set<TraitWeight>(TRAIT_KEY_PREFIX + trait_id, updated)
  }
}
