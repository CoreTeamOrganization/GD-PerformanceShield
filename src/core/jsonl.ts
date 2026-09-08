/**
 * Append-only JSONL storage.
 *
 * Telemetry and event markers are written this way rather than into a database
 * so that a crashed or force-quit session still leaves every sample that was
 * taken before the crash on disk — which is precisely the session we care most
 * about when hunting an OOM.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

export class JsonlWriter<T> {
  private stream: WriteStream | null = null;
  private count = 0;

  constructor(readonly path: string) {}

  private open(): WriteStream {
    if (!this.stream) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.stream = createWriteStream(this.path, { flags: 'a' });
    }
    return this.stream;
  }

  write(record: T): void {
    this.open().write(`${JSON.stringify(record)}\n`);
    this.count++;
  }

  get written(): number {
    return this.count;
  }

  async close(): Promise<void> {
    const s = this.stream;
    if (!s) return;
    this.stream = null;
    await new Promise<void>((res) => s.end(res));
  }
}

/** Stream a JSONL file record by record; malformed trailing lines are skipped. */
export async function* readJsonl<T>(path: string): AsyncGenerator<T> {
  if (!existsSync(path)) return;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as T;
    } catch {
      // A truncated final line is expected after a hard kill — ignore it.
    }
  }
}

export async function readJsonlAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for await (const rec of readJsonl<T>(path)) out.push(rec);
  return out;
}
