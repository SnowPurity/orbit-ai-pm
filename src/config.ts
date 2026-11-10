import path from 'node:path';

try {
  process.loadEnvFile();
} catch {
  // .env is optional.
}

export interface WeKnoraConfig {
  baseUrl: string;
  apiKey: string;
  defaultAgentId: string | null;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  filesDir: string;
  maxUploadBytes: number;
  taskFileLimit: number;
  projectStorageQuotaBytes: number;
  logLevel: string;
  timezone: string;
  schedulerEnabled: boolean;
  weknora: WeKnoraConfig | null;
  weknoraUiUrl: string | null;
  llm: LlmConfig | null;
}

function envInt(name: string, fallback: number, min = 1): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

function weknoraUiBase(apiUrl: string | undefined, override: string | undefined): string | null {
  const raw = override || apiUrl;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const pathname = override ? url.pathname : url.pathname.replace(/\/api\/v1$/i, '');
    return `${url.origin}${pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = process.env;
  const weknoraUrl = env.WEKNORA_API_URL?.trim();
  const weknoraKey = env.WEKNORA_API_KEY?.trim();
  const deepseekKey = env.DEEPSEEK_API_KEY?.trim();
  const config: AppConfig = {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '127.0.0.1',
    dbPath: path.resolve(env.ORBIT_DB_PATH ?? './data/orbit.db'),
    filesDir: path.resolve(env.ORBIT_FILES_DIR ?? './data/files'),
    maxUploadBytes: envInt('ORBIT_MAX_UPLOAD_MB', 50) * 1024 * 1024,
    taskFileLimit: envInt('ORBIT_TASK_FILE_LIMIT', 20),
    projectStorageQuotaBytes: envInt('ORBIT_PROJECT_QUOTA_MB', 2048) * 1024 * 1024,
    logLevel: env.ORBIT_LOG_LEVEL ?? 'info',
    timezone: env.ORBIT_TIMEZONE ?? 'Asia/Shanghai',
    schedulerEnabled: env.ORBIT_DISABLE_SCHEDULER !== '1',
    weknora:
      weknoraUrl && weknoraKey
        ? {
            baseUrl: weknoraUrl.replace(/\/+$/, ''),
            apiKey: weknoraKey,
            defaultAgentId: env.WEKNORA_AGENT_ID?.trim() || null,
          }
        : null,
    weknoraUiUrl: weknoraUiBase(weknoraUrl, env.WEKNORA_UI_URL?.trim()),
    llm: deepseekKey
      ? {
          baseUrl: (env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
          apiKey: deepseekKey,
          model: env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat',
        }
      : null,
    ...overrides,
  };
  // Tests and embedders often override only dbPath; keep uploads beside that database.
  if (!env.ORBIT_FILES_DIR && overrides.dbPath && !overrides.filesDir) {
    config.filesDir = path.join(path.dirname(config.dbPath), 'files');
  }
  return config;
}
