import Redis from "ioredis";

export interface RateLimitRedisOptions {
  url: string;
}

/** ioredis client tuned for rate-limit fail-fast behavior. */
export function createRateLimitRedis(options: RateLimitRedisOptions): Redis {
  return new Redis(options.url, {
    connectTimeout: 500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
}

export async function connectRateLimitRedis(client: Redis): Promise<void> {
  await client.connect();
}
