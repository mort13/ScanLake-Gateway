interface RateLimitResult {
  allowed: boolean
  remaining?: number
  retryAfterMs?: number
}

export async function checkRateLimit(
  namespace: DurableObjectNamespace,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const id = namespace.idFromName(key)
  const stub = namespace.get(id)

  const res = await stub.fetch('https://rate-limiter/check', {
    method: 'POST',
    body: JSON.stringify({ limit, windowMs }),
  })

  return res.json()
}

export async function getGlobalBudgetUsage(
  namespace: DurableObjectNamespace,
  key: string,
  windowMs: number,
): Promise<{ count: number }> {
  const id = namespace.idFromName(key)
  const stub = namespace.get(id)
  const res = await stub.fetch(
    `https://rate-limiter/status?windowMs=${windowMs}`,
    { method: 'GET' },
  )
  return res.json()
}
