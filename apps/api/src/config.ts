export interface DevelopmentConfig {
  host: string;
  port: number;
  userId: string;
  token: string;
  demoData: boolean;
}

export function loadConfig(environment: NodeJS.ProcessEnv): DevelopmentConfig {
  if (!['development', 'test'].includes(environment.NODE_ENV ?? '')) {
    throw new Error('This development slice cannot start outside development/test environments');
  }
  if (environment.PETPAL_STORAGE !== 'memory' || environment.PETPAL_AUTH !== 'development') {
    throw new Error('Only explicitly enabled development authentication and memory storage are implemented');
  }
  const host = environment.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Development server must listen on a loopback address');
  const port = Number(environment.PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const token = environment.PETPAL_DEV_TOKEN ?? '';
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) {
    throw new Error('Set PETPAL_DEV_TOKEN to a random 32-256 character local-only token');
  }
  const userId = environment.PETPAL_DEV_USER_ID ?? 'local-user';
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(userId)) throw new Error('Invalid PETPAL_DEV_USER_ID');
  if (!['true', 'false'].includes(environment.PETPAL_ENABLE_DEMO_DATA ?? 'false')) {
    throw new Error('PETPAL_ENABLE_DEMO_DATA must be true or false');
  }
  return { host, port, userId, token, demoData: environment.PETPAL_ENABLE_DEMO_DATA === 'true' };
}
