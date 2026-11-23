import type { Context } from 'hono'
import type { Env, AppVariables } from '../types'
import { getWindowUsage } from '../services/rate-limit'
import { GLOBAL_LIMIT } from '../lib/limits'

type AdminEnv = {
  Bindings: Env
  Variables: AppVariables
}

/**
 * GET /api/admin/budget
 *
 * Returns the global request budget usage for the current fixed 30-day window.
 * Requires an internal API key (user keys get 403) but does not consume a
 * rate-limit slot.
 */
export async function budgetStatusRoute(c: Context<AdminEnv>): Promise<Response> {
  const { limit, windowMs } = GLOBAL_LIMIT
  const { count, resetMs } = await getWindowUsage(c.env.RATE_LIMITER, 'gw-global', windowMs)
  const remaining = Math.max(0, limit - count)
  const usedPct = ((count / limit) * 100).toFixed(2)

  return c.json({
    used: count,
    limit,
    remaining,
    usedPercent: Number(usedPct),
    windowMs,
    windowLabel: '30-day window',
    resetsAt: new Date(Date.now() + resetMs).toISOString(),
  })
}
