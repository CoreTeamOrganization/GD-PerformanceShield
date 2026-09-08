/**
 * Project-folder probe tests.
 *
 * The console calls this while the operator is still typing, so the two things
 * that matter are that it answers correctly and that it never throws: a
 * half-typed path is the normal case, not an error condition.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { probeUnityProject } from '../src/intake/unityProject.js';
import { createFixtureProject } from './fixtures/unityProject.js';

let root: string;
let projectRoot: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'oom-probe-'));
  projectRoot = join(root, 'GreatGame');
  createFixtureProject(projectRoot);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('probeUnityProject', () => {
  it('accepts a real Unity project and reports what is in it', () => {
    const probe = probeUnityProject(projectRoot);

    expect(probe.valid).toBe(true);
    expect(probe.reason).toBeNull();
    expect(probe.unityVersion).toBe('2022.3.20f1');
    // The console shows these beside "Analyze code and assets", so they have to
    // be the project's real values rather than placeholders.
    expect(probe.scriptingBackend).toMatch(/IL2CPP|Mono/);
    expect(probe.sceneCount).toBeGreaterThan(0);
  });

  it('rejects a folder that is not a Unity project, and says why', () => {
    const probe = probeUnityProject(root);

    expect(probe.valid).toBe(false);
    // The operator has to be able to act on this without reading the source.
    expect(probe.reason).toMatch(/Assets\/|ProjectSettings\//);
    expect(probe.unityVersion).toBeNull();
  });

  it('rejects a path that does not exist rather than throwing', () => {
    // Exactly what a half-typed path looks like.
    const probe = probeUnityProject(join(root, 'C:\\builds\\Gr'));

    expect(probe.valid).toBe(false);
    expect(probe.reason).toBe('That folder does not exist.');
  });

  it('rejects a file pointed at instead of a folder', () => {
    const file = join(root, 'game.apk');
    writeFileSync(file, 'not a folder');

    const probe = probeUnityProject(file);

    expect(probe.valid).toBe(false);
    expect(probe.reason).toBe('That is a file, not a folder.');
  });

  it('treats an empty path as nothing chosen, not as an error', () => {
    // The project folder is optional, so an empty box must not read as a fault.
    const probe = probeUnityProject('   ');

    expect(probe.valid).toBe(false);
    expect(probe.reason).toBeNull();
  });

  it('names the missing folder when only one of the two is there', () => {
    // Assets/ present, ProjectSettings/ absent - the "pointed at a subfolder"
    // case, where naming the one that is missing is the whole value.
    const partial = join(root, 'HalfProject');
    mkdirSync(join(partial, 'Assets'), { recursive: true });

    const probe = probeUnityProject(partial);

    expect(probe.valid).toBe(false);
    expect(probe.reason).toContain('ProjectSettings/');
    expect(probe.reason).not.toContain('Assets/ or');
  });
});
