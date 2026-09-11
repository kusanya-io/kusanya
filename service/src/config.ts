/** Validated runtime settings; errors name settings without echoing secret values. */
export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel:
    'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly databaseUrl: string;
  readonly databaseSsl: boolean;
  readonly databasePoolMax: number;
  readonly databaseTimeoutMs: number;
}

export class ConfigurationError extends Error {
  constructor(setting: string) {
    super(`Invalid or missing configuration: ${setting}`);
    this.name = 'ConfigurationError';
  }
}

function integerSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new ConfigurationError(name);
  return value;
}

function enumSetting<const T extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  name: string,
  choices: T,
  fallback: T[number],
): T[number] {
  const value = env[name] ?? fallback;
  if (!choices.includes(value)) throw new ConfigurationError(name);
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = enumSetting(
    env,
    'NODE_ENV',
    ['development', 'test', 'production'],
    'development',
  );
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigurationError('DATABASE_URL');
  try {
    const parsed = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname.length < 2 ||
      parsed.search ||
      parsed.hash
    )
      throw new Error('Invalid database URL');
  } catch {
    throw new ConfigurationError('DATABASE_URL');
  }
  const databaseSsl =
    enumSetting(env, 'DATABASE_SSL', ['true', 'false'], 'true') === 'true';
  if (nodeEnv === 'production' && !databaseSsl)
    throw new ConfigurationError('DATABASE_SSL (must be true in production)');
  const host = env.HOST ?? '127.0.0.1';
  if (!host.trim() || host !== host.trim())
    throw new ConfigurationError('HOST');
  return Object.freeze({
    nodeEnv,
    host,
    port: integerSetting(env, 'PORT', 3000, 65535),
    logLevel: enumSetting(
      env,
      'LOG_LEVEL',
      ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
      'info',
    ),
    databaseUrl,
    databaseSsl,
    databasePoolMax: integerSetting(env, 'DATABASE_POOL_MAX', 10, 100),
    databaseTimeoutMs: integerSetting(env, 'DATABASE_TIMEOUT_MS', 3000, 30000),
  });
}
