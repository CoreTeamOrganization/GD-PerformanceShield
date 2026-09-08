/**
 * End-to-end test: intake -> static analysis -> scoring -> report.
 *
 * The device phase is exercised separately (it needs hardware), so this covers
 * the fully unattended path a studio can run in CI. It asserts the pipeline
 * produces a schema-valid report on disk, not just an in-memory object.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetConfig, loadConfig } from '../src/core/config.js';
import { listJobs } from '../src/core/job.js';
import { AnalysisPipeline } from '../src/pipeline/pipeline.js';
import { renderPrintableHtml } from '../src/report/html.js';
import { firstSentences, renderMarkdown } from '../src/report/markdown.js';
import { validateReport, type AnalysisReport } from '../src/report/model.js';
import { createFixtureApk, createFixtureProject } from './fixtures/unityProject.js';

let workRoot: string;
let projectRoot: string;
let apkPath: string;
let report: AnalysisReport;
let pipeline: AnalysisPipeline;

beforeAll(async () => {
  workRoot = mkdtempSync(join(tmpdir(), 'oom-e2e-'));
  projectRoot = join(workRoot, 'project');
  createFixtureProject(projectRoot);
  apkPath = createFixtureApk(join(workRoot, 'build', 'fixture.apk'));

  // Point the workspace at the temp directory so the test never writes into
  // the developer's real analysis/ folder.
  process.env['GDPS_WORKSPACE_ROOT'] = join(workRoot, 'analysis');
  resetConfig();

  pipeline = new AnalysisPipeline({
    input: {
      gameName: 'Fixture Game',
      studio: 'Fixture Studio',
      apkPath,
    },
    staticOnly: true,
  });

  await pipeline.runLocalIntakeAndStatic(projectRoot);
  report = await pipeline.finish();
}, 60_000);

afterAll(() => {
  delete process.env['GDPS_WORKSPACE_ROOT'];
  resetConfig();
  rmSync(workRoot, { recursive: true, force: true });
});

describe('end-to-end static pipeline', () => {
  it('completes and marks the job finished', () => {
    expect(pipeline.job.status).toBe('completed');
    const stages = pipeline.job.meta.stages;
    expect(stages.find((s) => s.name === 'static.analysis')?.status).toBe('ok');
    expect(stages.find((s) => s.name === 'apk.inspect')?.status).toBe('ok');
    expect(stages.find((s) => s.name === 'report.generate')?.status).toBe('ok');
  });

  it('produces a report that satisfies the published schema', () => {
    expect(() => validateReport(report)).not.toThrow();
    expect(report.schemaVersion).toBe(1);
  });

  it('writes both JSON and Markdown to the workspace', () => {
    const paths = pipeline.state.reportPaths;
    expect(paths.json && existsSync(paths.json)).toBe(true);
    expect(paths.markdown && existsSync(paths.markdown)).toBe(true);

    const stored = JSON.parse(readFileSync(paths.json!, 'utf8'));
    expect(() => validateReport(stored)).not.toThrow();
  });

  it('creates the full workspace directory layout from Step 1', () => {
    const root = pipeline.job.workspace.root;
    for (const dir of ['metadata', 'source', 'static', 'apk', 'devices', 'telemetry', 'logs', 'events', 'reports']) {
      expect(existsSync(join(root, dir))).toBe(true);
    }
    expect(existsSync(join(root, 'metadata', 'job.json'))).toBe(true);
  });

  it('identifies the subject from both the APK and the project', () => {
    expect(report.subject.gameName).toBe('Fixture Game');
    expect(report.subject.packageName).toBe('com.fixture.game');
    expect(report.subject.versionName).toBe('1.4.2');
    expect(report.subject.unityVersion).toBe('2022.3.20f1');
    expect(report.subject.scriptingBackend).toBe('IL2CPP');
    expect(report.subject.abis).toEqual(['arm64-v8a']);
  });

  it('reports static risk but no live risk, and says the run was unverified', () => {
    expect(report.verdict.staticRisk.value).toBeGreaterThan(0);
    expect(report.verdict.liveRisk.value).toBe(0);
    expect(report.verdict.headline).toContain('static analysis only');
    expect(report.session).toBeNull();
  });

  it('states its own limitations rather than presenting the result as complete', () => {
    const joined = report.limitations.join(' ');
    expect(joined).toContain('No live device session');
    expect(report.verdict.confidence.value).toBeLessThan(0.7);
  });

  it('ranks findings by what to fix first', () => {
    expect(report.priority.length).toBeGreaterThan(3);
    const scores = report.priority.map((p) => p.priorityScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(report.priority[0]?.reason).toContain('predicted from the project');
  });

  it('renders Markdown containing the headline, devices note and fixes', () => {
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('# Fixture Game - memory risk report');
    expect(markdown).toContain('## Out of memory risk');
    expect(markdown).toContain('## What should we fix first?');
    expect(markdown).toContain('com.fixture.game');
    // Recommendations must reach the reader, not just the JSON.
    expect(markdown).toContain('Recommended fix');
  });

  it('registers the analysis in the job list', () => {
    const jobs = listJobs(loadConfig(), 10);
    expect(jobs.some((j) => j.analysisId === pipeline.job.id)).toBe(true);
  });
});

describe('project path as a first-class input', () => {
  it('accepts a local project folder without a repository, and says it was not cloned', async () => {
    const local = new AnalysisPipeline({
      input: { gameName: 'Path Input', projectPath: projectRoot, apkPath },
      staticOnly: true,
    });

    await local.runIntakeAndStatic();
    const report = await local.finish();

    expect(local.job.stage('intake.repository')?.status).toBe('ok');
    expect(local.job.stage('intake.repository')?.message).toContain('not cloned');
    expect(report.subject.repository).toBeNull();
    expect(report.project?.assetCount).toBeGreaterThan(0);
  }, 60_000);

  it('fails cleanly when neither a project nor an APK can be read', async () => {
    const empty = new AnalysisPipeline({
      input: { gameName: 'Nothing', projectPath: join(workRoot, 'does-not-exist') },
      staticOnly: true,
    });

    await expect(empty.runIntakeAndStatic()).rejects.toThrow(/Nothing to analyze/);
    expect(empty.job.status).toBe('failed');
  }, 30_000);

  it('accepts an app already installed on a device as the only subject', async () => {
    // No project, no APK - just a package name. The intake must not fail: the
    // package plus its launch component is all the profiling phase needs.
    const installed = new AnalysisPipeline({
      input: { gameName: 'Installed Only', packageName: 'com.studio.cosmicracer' },
      staticOnly: true,
    });

    await installed.runIntakeAndStatic();

    expect(installed.job.status).not.toBe('failed');
    expect(installed.job.stage('intake.apk')?.status).toBe('skipped');
    expect(installed.job.stage('intake.apk')?.message).toContain('com.studio.cosmicracer');
    expect(installed.job.stage('apk.inspect')?.status).toBe('skipped');
  }, 30_000);
});

describe('report audience cuts', () => {
  it('writes exactly two cuts: a summary and a complete report', () => {
    // The developer cut was dropped: it was the complete report with some of
    // the evidence removed, which is the one thing an engineer fixing the
    // problem does not want.
    const paths = pipeline.state.reportPaths.byAudience;
    expect(paths).toBeDefined();
    for (const audience of ['lead', 'complete']) {
      expect(paths![audience] && existsSync(paths![audience]!)).toBe(true);
    }
    expect(Object.keys(paths!).sort()).toEqual(['complete', 'lead']);
  });

  it('gives the lead a snapshot, not a shortened report', () => {
    const lead = renderMarkdown(report, 'lead');

    // The summary answers the six questions and stops. Its headings are the
    // answers themselves, not the report's sections.
    expect(lead).toContain('**Performance Snapshot');
    expect(lead).toContain('RISK —');
    expect(lead).toContain('**Confidence:');
    expect(lead).toContain('## What is the biggest problem?');
    expect(lead).toContain('## How did it play?');
    expect(lead).toContain('## Bottom line');

    // A lead should never be shown source locations or code blocks, and the
    // detail that explains the numbers belongs in the complete cut.
    expect(lead).not.toContain('```csharp');
    expect(lead).not.toContain('Assets/Scripts/');
    expect(lead).not.toContain('## All findings');
    expect(lead).not.toContain('## Largest memory jumps');
    expect(lead).not.toContain('## How the risk score breaks down');
  });

  it('gives the developer exact locations and fixes', () => {
    const dev = renderMarkdown(report, 'developer');
    expect(dev).toContain('Recommended fix');
    expect(dev).toContain('Where to look');
    expect(dev).toContain('Assets/');
  });

  it('gives the analyst everything, and is the largest cut', () => {
    const lead = renderMarkdown(report, 'lead');
    const dev = renderMarkdown(report, 'developer');
    const complete = renderMarkdown(report, 'complete');

    expect(complete).toContain('## All findings');
    expect(complete).toContain('## Limitations');
    expect(complete.length).toBeGreaterThan(dev.length);
    expect(dev.length).toBeGreaterThan(lead.length);
  });

  it('does not split sentences on decimals or dotted identifiers', () => {
    expect(
      firstSentences('It costs 85.3 MB in memory. Next sentence.', 1),
    ).toBe('It costs 85.3 MB in memory.');
    expect(
      firstSentences('Pair LoadAssetAsync with Addressables.Release when closing.', 1),
    ).toBe('Pair LoadAssetAsync with Addressables.Release when closing.');
    expect(firstSentences('No punctuation here', 1)).toBe('No punctuation here');
  });
});

describe('printable HTML for PDF export', () => {
  it('is a complete standalone document', () => {
    const html = renderPrintableHtml(report, 'complete');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    // Self-contained: the styles ship inside the file, nothing is fetched.
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('src="http');
  });

  it('explains itself to a reader who has never used the tool', () => {
    for (const audience of ['developer', 'complete'] as const) {
      const html = renderPrintableHtml(report, audience);
      expect(html).toContain('About this report');
      expect(html).toContain('confidence score');
    }

    // The summary has no room for a primer, but it cannot leave the one
    // distinction that would mislead a reader who only gets this page.
    const lead = renderPrintableHtml(report, 'lead');
    expect(lead).toContain('<strong>Risk</strong>');
    expect(lead).toContain('<strong>Confidence</strong>');
  });

  it('carries no references a external reader could not follow', () => {
    for (const audience of ['lead', 'developer', 'complete'] as const) {
      const html = renderPrintableHtml(report, audience);
      // Pointing at internal files or sibling reports is a dead end for
      // someone who was only sent this one PDF.
      expect(html).not.toContain('report.json');
      expect(html).not.toContain('see the complete report');
      expect(html).not.toContain('the developer report');
      expect(html).not.toContain('localhost');
    }
  });

  it('keeps the lead cut free of code and file paths', () => {
    const html = renderPrintableHtml(report, 'lead');
    expect(html).toContain('What is the biggest problem?');
    expect(html).toContain('Bottom line');
    expect(html).not.toContain('Assets/Scripts/');
    expect(html).not.toContain('<pre>');
    // Match the heading, not the words: "All findings are unverified
    // predictions" is legitimate caveat prose that may appear anywhere.
    expect(html).not.toContain('<h2>All findings</h2>');
  });

  it('gives the developer cut evidence locations', () => {
    const html = renderPrintableHtml(report, 'developer');
    expect(html).toContain('Recommended fix');
    expect(html).toContain('Where to look');
    expect(html).toContain('Assets/');
  });

  it('grows with audience depth', () => {
    const lead = renderPrintableHtml(report, 'lead');
    const dev = renderPrintableHtml(report, 'developer');
    const complete = renderPrintableHtml(report, 'complete');
    expect(complete.length).toBeGreaterThan(dev.length);
    expect(dev.length).toBeGreaterThan(lead.length);
    expect(complete).toContain('<h2>All findings</h2>');
    expect(dev).not.toContain('<h2>All findings</h2>');
  });

  it('escapes content so a game name cannot break the document', () => {
    const hostile = {
      ...report,
      subject: { ...report.subject, gameName: '<script>alert(1)</script> & "co"' },
    };
    const html = renderPrintableHtml(hostile, 'lead');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('only auto-prints when asked, for the browser fallback', () => {
    expect(renderPrintableHtml(report, 'lead')).not.toContain('window.print()');
    expect(renderPrintableHtml(report, 'lead', { autoPrint: true })).toContain('window.print()');
  });

  it('sets page geometry so the PDF paginates predictably', () => {
    const html = renderPrintableHtml(report, 'complete');
    expect(html).toContain('@page');
    expect(html).toContain('size: A4');
    // Findings and table rows must not be split across a page boundary.
    expect(html).toContain('break-inside: avoid');
  });
});
