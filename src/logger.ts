const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const envLevel = (process.env.LOG_LEVEL ?? "info").trim().toLowerCase() as Level;
const threshold = LEVELS[envLevel] ?? LEVELS.info;

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function emit(level: Level, scope: string, msg: string): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `${COLORS[level]}${ts} [${level.toUpperCase()}] [${scope}]${RESET} ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg) => emit("debug", scope, msg),
    info: (msg) => emit("info", scope, msg),
    warn: (msg) => emit("warn", scope, msg),
    error: (msg) => emit("error", scope, msg),
  };
}
