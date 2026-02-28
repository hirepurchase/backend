type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const cacheStore = new Map<string, CacheEntry<unknown>>();

const DEFAULT_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 60);

function now(): number {
  return Date.now();
}

export function getCache<T>(key: string): T | null {
  const entry = cacheStore.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;

  if (entry.expiresAt <= now()) {
    cacheStore.delete(key);
    return null;
  }

  return entry.value;
}

export function setCache<T>(key: string, value: T, ttlSeconds: number = DEFAULT_TTL_SECONDS): void {
  cacheStore.set(key, {
    value,
    expiresAt: now() + ttlSeconds * 1000,
  });
}

export function deleteCache(key: string): void {
  cacheStore.delete(key);
}

export function clearCache(prefix?: string): void {
  if (!prefix) {
    cacheStore.clear();
    return;
  }

  for (const key of cacheStore.keys()) {
    if (key.startsWith(prefix)) {
      cacheStore.delete(key);
    }
  }
}

export function getOrSetCache<T>(key: string, producer: () => Promise<T>, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<T> {
  const cached = getCache<T>(key);
  if (cached !== null) {
    return Promise.resolve(cached);
  }

  return producer().then((result) => {
    setCache(key, result, ttlSeconds);
    return result;
  });
}

