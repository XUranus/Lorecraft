import { describe, it, expect } from 'vitest'
import { prompts } from './prompts.js'

// ---------------------------------------------------------------------------
// All prompt files loaded
// ---------------------------------------------------------------------------

const EXPECTED_PROMPTS = [
  'input_parser',
  'action_arbiter',
  'event_generator',
  'voice_debate',
  'signal_b_tagger',
  'narrative_progress_assessor',
  'world_generator',
  'inner_voice_generator',
  'fact_extractor',
  'lore_consistency_checker',
  'drift_assessor',
  'feasibility_judge',
  'check_dm',
  'debate_generator',
  'pacing_judge',
  'ambiguity_resolver',
  'intervention_l1',
  'intervention_l2',
  'intervention_l3',
  'lazy_eval',
  'npc_response_tier_c',
]

describe('Prompt registry completeness', () => {
  it('loads all expected prompt files', () => {
    for (const name of EXPECTED_PROMPTS) {
      expect(prompts.has(name), `missing prompt: ${name}`).toBe(true)
    }
  })

  it('every loaded prompt is non-empty', () => {
    for (const name of prompts.names()) {
      const content = prompts.get(name)
      expect(content.trim().length, `empty prompt: ${name}`).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// input_parser.prompt
// ---------------------------------------------------------------------------

describe('input_parser prompt', () => {
  const content = prompts.get('input_parser')

  it('requires JSON-only output', () => {
    expect(content).toContain('ONLY valid JSON')
  })

  it('defines ParsedIntent schema fields', () => {
    expect(content).toContain('atomic_actions')
    expect(content).toContain('intent')
    expect(content).toContain('tone_signals')
    expect(content).toContain('world_assertions')
    expect(content).toContain('ambiguity_flags')
  })

  it('has NARRATIVE AUTHORITY RULE to prevent world assertions in actions', () => {
    expect(content).toContain('NARRATIVE AUTHORITY RULE')
    expect(content).toContain('world_assertions')
  })

  it('has FIDELITY RULE to prevent intent softening', () => {
    expect(content).toContain('FIDELITY RULE')
    expect(content).toContain('not a censor')
    // Must include violent action examples to anchor LLM behavior
    expect(content).toContain('ATTACK')
  })

  it('enforces single action output', () => {
    expect(content).toContain('exactly ONE atomic action')
  })
})

// ---------------------------------------------------------------------------
// action_arbiter.prompt
// ---------------------------------------------------------------------------

describe('action_arbiter prompt', () => {
  const content = prompts.get('action_arbiter')

  it('requires JSON-only output', () => {
    expect(content).toContain('ONLY valid JSON')
  })

  it('has feasibility and skill check sections', () => {
    expect(content).toContain('FEASIBILITY')
    expect(content).toContain('SKILL CHECK')
  })

  it('defines all four assessment dimensions', () => {
    expect(content).toContain('Information completeness')
    expect(content).toContain('Physical/spatial feasibility')
    expect(content).toContain('Logical consistency')
    expect(content).toContain('Narrative drift')
  })

  it('never rejects based on social appropriateness', () => {
    expect(content).toContain('NEVER reject an action because it is socially inappropriate')
  })

  it('defines all difficulty levels', () => {
    for (const level of ['TRIVIAL', 'ROUTINE', 'HARD', 'VERY_HARD', 'LEGENDARY']) {
      expect(content).toContain(level)
    }
  })

  it('has {{attribute_list}} placeholder for template filling', () => {
    expect(content).toContain('{{attribute_list}}')
  })

  it('fills {{attribute_list}} placeholder correctly', () => {
    const filled = prompts.fill('action_arbiter', {
      attribute_list: 'STR, DEX, CON, INT, WIS, CHA',
    })
    expect(filled).toContain('STR, DEX, CON, INT, WIS, CHA')
    expect(filled).not.toContain('{{attribute_list}}')
  })
})

// ---------------------------------------------------------------------------
// event_generator.prompt
// ---------------------------------------------------------------------------

describe('event_generator prompt', () => {
  const content = prompts.get('event_generator')

  it('requires JSON-only output', () => {
    expect(content).toContain('ONLY valid JSON')
  })

  it('defines event output schema fields', () => {
    expect(content).toContain('narrative_text')
    expect(content).toContain('state_changes')
    expect(content).toContain('character_observations')
    expect(content).toContain('choices')
    expect(content).toContain('weight')
  })

  it('has CRITICAL OUTCOMES section for crit success/failure', () => {
    expect(content).toContain('CRITICAL_SUCCESS')
    expect(content).toContain('CRITICAL_FAILURE')
    expect(content).toContain('luck_value')
  })

  it('has PLAYER INPUT instruction for original text passthrough', () => {
    expect(content).toContain('PLAYER INPUT')
    expect(content).toContain('player_input')
  })

  it('has NARRATIVE CONTINUITY rule', () => {
    expect(content).toContain('NARRATIVE CONTINUITY')
  })

  it('enforces exactly 2 choices', () => {
    expect(content).toContain('exactly 2 choices')
  })

  it('has formatting rules for dialogue and sound effects', () => {
    expect(content).toContain('「」')
    expect(content).toContain('『』')
  })

  it('defines all event weight levels', () => {
    for (const w of ['PRIVATE', 'MINOR', 'SIGNIFICANT', 'MAJOR']) {
      expect(content).toContain(w)
    }
  })

  it('has all dynamic placeholders', () => {
    for (const ph of [
      'tone_instruction',
      'tension_instruction',
      'narrative_direction_instruction',
      'beat_instruction',
      'force_instruction',
      'pacing_instruction',
    ]) {
      expect(content).toContain(`{{${ph}}}`)
    }
  })

  it('fills placeholders and removes unfilled ones cleanly', () => {
    const filled = prompts.fill('event_generator', {
      tone_instruction: 'TONE: dark and gritty',
      force_instruction: 'FORCE: high',
    })
    expect(filled).toContain('TONE: dark and gritty')
    expect(filled).toContain('FORCE: high')
    // Unfilled optional placeholders should be stripped
    expect(filled).not.toContain('{{tension_instruction}}')
    expect(filled).not.toContain('{{beat_instruction}}')
    expect(filled).not.toContain('{{pacing_instruction}}')
    expect(filled).not.toContain('{{narrative_direction_instruction}}')
  })
})

// ---------------------------------------------------------------------------
// world_generator.prompt — conflict intensity scaling
// ---------------------------------------------------------------------------

describe('world_generator prompt', () => {
  const content = prompts.get('world_generator')

  it('has conflict intensity scaling section', () => {
    expect(content).toMatch(/冲突强度.*匹配.*基调|基调.*冲突强度/)
  })
})

// ---------------------------------------------------------------------------
// General prompt quality checks
// ---------------------------------------------------------------------------

describe('Prompt quality guards', () => {
  it('no prompt exceeds 8000 characters (prevents bloat)', () => {
    for (const name of prompts.names()) {
      const content = prompts.get(name)
      expect(
        content.length,
        `prompt "${name}" is ${content.length} chars — consider trimming`,
      ).toBeLessThan(8000)
    }
  })

  it('all prompts with JSON output mention "JSON"', () => {
    // Prompts that ask LLM to return structured data must say "JSON"
    const structuredPrompts = [
      'input_parser',
      'action_arbiter',
      'event_generator',
      'signal_b_tagger',
      'narrative_progress_assessor',
      'fact_extractor',
    ]
    for (const name of structuredPrompts) {
      const content = prompts.get(name)
      expect(content.toUpperCase(), `prompt "${name}" should mention JSON`).toContain('JSON')
    }
  })

  it('no prompt contains leftover TODO/FIXME markers', () => {
    for (const name of prompts.names()) {
      const content = prompts.get(name)
      expect(content).not.toMatch(/\bTODO\b/i)
      expect(content).not.toMatch(/\bFIXME\b/i)
      expect(content).not.toMatch(/\bHACK\b/i)
    }
  })
})
