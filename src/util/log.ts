// Tiny scoped logger. Level from GOLEM_LOG (debug|info|warn|error), default info.
// We deliberately don't pull in a logging library: stderr lines with a scope prefix are enough for
// a process whose real record of events is the JSONL trace (see body/trace.ts).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const envLevel = (process.env.GOLEM_LOG ?? "info") as LogLevel;
const threshold = LEVELS[envLevel] ?? LEVELS.info;

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export interface Logger {
  debug(msg: string, ...rest: unknown[]): void;
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
  child(scope: string): Logger;
}

export function makeLog(scope: string): Logger {
  const emit = (level: LogLevel, msg: string, rest: unknown[]) => {
    if (LEVELS[level] < threshold) return;
    const line = `${stamp()} ${level.padEnd(5)} [${scope}] ${msg}`;
    if (level === "error" || level === "warn") console.error(line, ...rest);
    else console.error(line, ...rest);
  };
  return {
    debug: (m, ...r) => emit("debug", m, r),
    info: (m, ...r) => emit("info", m, r),
    warn: (m, ...r) => emit("warn", m, r),
    error: (m, ...r) => emit("error", m, r),
    child: (sub) => makeLog(`${scope}:${sub}`),
  };
}
