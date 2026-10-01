/**
 * The pure Bot Mode routine-prompt logic — extracted from `cron.tsx` so a
 * node-environment test can exercise it WITHOUT dragging the UI component
 * tree (and its `window`/DOM deps) into the test's import graph.
 *
 * A job scheduled for the ACTIVE bot profile runs its instruction directly.
 * A job for a different profile keeps the `hermes -p <bot> chat` delegation
 * wrapper so the run lands in that bot's own history — and that wrapper is a
 * shell command line, which is why every operand is single-quoted rather
 * than interpolated. The pre-hardening prompts were built by interpolation,
 * so a routine title or instruction containing `$(…)` executed on the
 * scheduler's machine; `isLegacyDelegatedRoutine` is how those persisted
 * jobs are still recognized and paused.
 */

import type { RoutineJob } from './types'

export const BOT_TAG_RE = /^\[bot:([a-z0-9][a-z0-9_-]*)\]\s*/i
const SAFE_ROUTINE_MARKER = '[bot-mode:routine:v2] '
const LEGACY_DELEGATED_ROUTINE_PREFIX = 'You are running the scheduled routine "'

export function routineBot(job: RoutineJob | null | undefined): null | string {
  const match = BOT_TAG_RE.exec(job?.name || '')

  return match ? match[1].toLowerCase() : null
}

export function isLegacyDelegatedRoutine(job: RoutineJob | null | undefined): boolean {
  const preview = typeof job?.prompt_preview === 'string' ? job.prompt_preview : job?.prompt

  return Boolean(routineBot(job) && typeof preview === 'string' && preview.startsWith(LEGACY_DELEGATED_ROUTINE_PREFIX))
}

export function normalizedProfileName(profile: unknown): string {
  return typeof profile === 'string' ? profile.trim().toLowerCase() : ''
}

function shellQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

export function routineInputError(title: string, instruction: string): null | string {
  if (String(title).includes('\0')) {
    return 'Job name cannot contain NUL (U+0000).'
  }

  if (String(instruction).includes('\0')) {
    return 'Job instruction cannot contain NUL (U+0000).'
  }

  return null
}

export function routinePrompt(bot: string | undefined, title: string, instruction: string, activeProfile: string): string {
  if (normalizedProfileName(bot) && normalizedProfileName(bot) === normalizedProfileName(activeProfile)) {
    return instruction
  }

  return (
    `${SAFE_ROUTINE_MARKER}You are running the scheduled routine "${title}" for agent '${bot}'. ` +
    `Execute it AS that agent so the run lands in its own history: run this in the terminal and relay the output:\n\n` +
    `hermes -p ${shellQuote(bot)} chat -c ${shellQuote(`Routine: ${title}`)} -q ${shellQuote(`[Scheduled routine] ${instruction}`)}\n\n` +
    `If the command fails, report the error instead.`
  )
}
