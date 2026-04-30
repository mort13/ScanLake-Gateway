import type { Context } from 'hono'
import type { Env, AppVariables } from '../types'
import { getGlobalBudgetUsage } from '../services/rate-limit'

// Keep in sync with rateLimit.ts
const GLOBAL_HARD_LIMIT = 10_000_000
const GLOBAL_WINDOW_MS = 2_592_000_000 // 30 days

type AdminEnv = {
  Bindings: Env
  Variables: AppVariables
}

/**
 * GET /api/admin/budget
 *
 * Returns the current global request budget usage for the rolling 30-day window.
 * Requires a valid API key but does not consume a rate-limit slot.
 */
export async function budgetStatusRoute(c: Context<AdminEnv>): Promise<Response> {
  const { count } = await getGlobalBudgetUsage(c.env.RATE_LIMITER, 'gw-global', GLOBAL_WINDOW_MS)
  const remaining = Math.max(0, GLOBAL_HARD_LIMIT - count)
  const usedPct = ((count / GLOBAL_HARD_LIMIT) * 100).toFixed(2)

  return c.json({
    used: count,
    limit: GLOBAL_HARD_LIMIT,
    remaining,
    usedPercent: Number(usedPct),
    windowMs: GLOBAL_WINDOW_MS,
    windowLabel: '30 days (rolling)',
  })
}
