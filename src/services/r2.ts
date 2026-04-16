export interface ListResult {
  objects: Pick<R2Object, 'key' | 'size' | 'uploaded'>[]
  truncated: boolean
  cursor?: string
}

export async function listFiles(
  bucket: R2Bucket,
  prefix?: string,
  limit = 100,
  cursor?: string,
): Promise<ListResult> {
  const options: R2ListOptions = { limit }
  if (prefix) options.prefix = prefix
  if (cursor) options.cursor = cursor

  const result = await bucket.list(options)

  return {
    objects: result.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
    truncated: result.truncated,
    ...(result.truncated ? { cursor: result.cursor } : {}),
  }
}

export async function getFile(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return bucket.get(key)
}
