/** Errors that carry an operator-facing remediation hint. */
export class PerformanceShieldError extends Error {
  readonly code: string;
  readonly hint?: string;
  override readonly cause?: unknown;

  constructor(code: string, message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'PerformanceShieldError';
    this.code = code;
    this.hint = opts.hint;
    this.cause = opts.cause;
  }
}

export class IntakeError extends PerformanceShieldError {
  constructor(message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super('INTAKE', message, opts);
    this.name = 'IntakeError';
  }
}

export class DeviceError extends PerformanceShieldError {
  constructor(message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super('DEVICE', message, opts);
    this.name = 'DeviceError';
  }
}

export class ApkError extends PerformanceShieldError {
  constructor(message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super('APK', message, opts);
    this.name = 'ApkError';
  }
}

export function describeError(err: unknown): string {
  if (err instanceof PerformanceShieldError) {
    return err.hint ? `${err.message} (hint: ${err.hint})` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
