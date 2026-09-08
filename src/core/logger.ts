/**
 * Dependency-free structured logger.
 *
 * Deliberately tiny: the operator runs this next to a phone on a test bench and
 * we want readable console output plus a machine-readable JSONL trail per job,
 * without pulling a logging framework into a tool that must install cleanly on
 * any studio machine.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { env } from './env.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const COLORS: Record<LogLevel, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[36m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';

let globalLevel: LogLevel = (env('LOG_LEVEL') as LogLevel) ?? 'info';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export interface Logger {
  trace(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
  /** Mirror every subsequent record into a JSONL file as well as the console. */
  tee(filePath: string): void;
}

class ConsoleLogger implements Logger {
  constructor(
    private readonly scope: string,
    private sinks: string[] = [],
  ) {}

  private write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[globalLevel]) return;
    const time = new Date().toISOString();
    const record = { time, level, scope: this.scope, msg, ...(data ?? {}) };

    for (const sink of this.sinks) {
      try {
        mkdirSync(dirname(sink), { recursive: true });
        appendFileSync(sink, `${JSON.stringify(record)}\n`);
      } catch {
        /* never let logging break the run */
      }
    }

    const tag = level.toUpperCase().padEnd(5);
    const head = useColor ? `${COLORS[level]}${tag}${RESET}` : tag;
    const extra = data && Object.keys(data).length > 0 ? ` ${formatData(data)}` : '';
    const line = `${time.slice(11, 23)} ${head} [${this.scope}] ${msg}${extra}`;
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  trace(m: string, d?: Record<string, unknown>) { this.write('trace', m, d); }
  debug(m: string, d?: Record<string, unknown>) { this.write('debug', m, d); }
  info(m: string, d?: Record<string, unknown>) { this.write('info', m, d); }
  warn(m: string, d?: Record<string, unknown>) { this.write('warn', m, d); }
  error(m: string, d?: Record<string, unknown>) { this.write('error', m, d); }

  child(scope: string): Logger {
    return new ConsoleLogger(`${this.scope}:${scope}`, this.sinks);
  }

  tee(filePath: string): void {
    if (!this.sinks.includes(filePath)) this.sinks.push(filePath);
  }
}

function formatData(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
}

export const logger: Logger = new ConsoleLogger('gdshield');

export function createLogger(scope: string): Logger {
  return logger.child(scope);
}
