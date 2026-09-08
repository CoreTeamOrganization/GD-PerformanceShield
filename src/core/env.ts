/**
 * Environment variable lookup.
 *
 * Settings are read as `GDPS_<NAME>`. The pre-rename `OOM_<NAME>` spelling is
 * accepted as a fallback so operator shells, CI jobs and shortcuts configured
 * while the tool was called GD-PerformanceShield keep working. Nothing writes the old
 * names; the fallback can be deleted once no environment still sets them.
 */
export function env(name: string): string | undefined {
  return process.env[`GDPS_${name}`] ?? process.env[`OOM_${name}`];
}
