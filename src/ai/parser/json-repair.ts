import type { AgentRunner } from '../runner/agent-runner.js'
import type { ParseError, ParseResult } from './response-parser.js'
import { ResponseParser } from './response-parser.js'

const REPAIR_SYSTEM_PROMPT = `You are a JSON repair tool. You receive malformed or invalid JSON and a description of the error. Your ONLY job is to output corrected, valid JSON.

Rules:
- Output ONLY the fixed JSON, no explanation, no markdown fences
- Preserve all meaningful content from the original
- Fix syntax errors (missing quotes, trailing commas, unescaped characters, truncated output)
- Fix schema violations (missing required fields, wrong types) using reasonable defaults
- If the original is completely unintelligible, reconstruct minimal valid JSON matching the schema`

/**
 * Attempt to repair broken LLM JSON output using a dedicated, context-free LLM call.
 * This works better than retrying the original prompt because:
 * 1. The repair prompt is trivial — even weak models handle it
 * 2. It doesn't carry the heavy game context that caused the original failure
 */
export async function repairJson(
  runner: AgentRunner,
  brokenOutput: string,
  error: ParseError,
  schemaHint: string,
): Promise<string> {
  const userMessage = [
    `Expected JSON schema:`,
    schemaHint,
    ``,
    `Error: ${error.type} — ${error.message}`,
    ``,
    `Broken output:`,
    brokenOutput,
  ].join('\n')

  const response = await runner.run(
    [
      { role: 'system', content: REPAIR_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    { agent_type: 'json_repair', temperature: 0 },
  )

  return response.content
}

/**
 * Parse LLM output, and if parsing fails, attempt a context-free JSON repair
 * before parsing again. Returns the final ParseResult.
 */
export async function parseWithRepair<T>(
  parser: ResponseParser<T>,
  runner: AgentRunner,
  rawContent: string,
  schemaHint: string,
): Promise<ParseResult<T>> {
  const result = parser.parse(rawContent)
  if (result.success) return result

  const repaired = await repairJson(runner, rawContent, result.error, schemaHint)
  return parser.parse(repaired)
}
