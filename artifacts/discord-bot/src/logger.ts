const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const currentLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

function print(level: Level, msg: string): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase().padEnd(5)}]`;
  if (level === 'error') {
    console.error(`${prefix} ${msg}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${msg}`);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

export const log = {
  debug: (msg: string) => print('debug', msg),
  info:  (msg: string) => print('info',  msg),
  warn:  (msg: string) => print('warn',  msg),
  error: (msg: string) => print('error', msg),
};
