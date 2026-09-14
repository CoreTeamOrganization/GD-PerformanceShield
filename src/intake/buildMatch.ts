/**
 * Does the Unity project the operator supplied describe the build being profiled?
 *
 * The correlation step joins a measurement on the device to a file in the
 * project and reports the pair as cause and effect. That is only true when the
 * project is the code the installed build came from; pointed at another game,
 * or at a checkout three releases newer, it would name a texture or a script
 * that is not in the APK at all, with the same confidence and the same
 * "measured on a real device" label. Nothing in the pipeline could tell.
 *
 * Two facts are checkable without the studio's cooperation, and both come from
 * ProjectSettings.asset on one side and the manifest on the other:
 *
 *  - the Android application identifier against the package being profiled
 *  - bundleVersion against the installed versionName
 *
 * The commit is not checkable: an APK carries no record of the source it was
 * built from. So a match here is a necessary condition, never a proof, and the
 * console says so beside the field.
 */

export type BuildMatchVerdict =
  /** Identifier and, where known, version agree. */
  | 'match'
  /** Same app, but the project's bundleVersion is not the installed version. */
  | 'version_differs'
  /** The project builds a different package than the one being profiled. */
  | 'identifier_differs'
  /** One side did not state an identifier, so nothing could be compared. */
  | 'unknown';

export interface BuildMatchProject {
  bundleIdentifier: string | null;
  bundleVersion: string | null;
}

export interface BuildMatchBuild {
  packageName: string | null;
  versionName: string | null;
}

export interface BuildMatch {
  verdict: BuildMatchVerdict;
  /** One sentence for the operator or the report reader, stating both values. */
  message: string;
  /** False only for `identifier_differs`: the one case where a correlation would be fiction. */
  correlationSafe: boolean;
}

export function assessBuildMatch(project: BuildMatchProject, build: BuildMatchBuild): BuildMatch {
  const projectId = clean(project.bundleIdentifier);
  const buildId = clean(build.packageName);

  if (!projectId || !buildId) {
    return {
      verdict: 'unknown',
      message:
        'Whether the project matches the profiled build could not be checked: ' +
        (projectId
          ? 'the package being profiled is not known.'
          : 'ProjectSettings.asset states no Android application identifier.'),
      correlationSafe: true,
    };
  }

  if (projectId !== buildId) {
    return {
      verdict: 'identifier_differs',
      message:
        `The project builds ${projectId}, but the app being profiled is ${buildId}. ` +
        'Its code and assets are not in that build, so no measured problem was traced to it.',
      correlationSafe: false,
    };
  }

  const projectVersion = clean(project.bundleVersion);
  const buildVersion = clean(build.versionName);
  if (projectVersion && buildVersion && projectVersion !== buildVersion) {
    return {
      verdict: 'version_differs',
      message:
        `The project is at version ${projectVersion} but the installed build is ${buildVersion}. ` +
        'Causes named in the project may have changed since that build was made.',
      correlationSafe: true,
    };
  }

  return {
    verdict: 'match',
    message:
      `The project's application identifier matches ${buildId}` +
      (projectVersion && buildVersion ? ` at version ${buildVersion}` : '') +
      '. The commit itself cannot be verified from an APK.',
    correlationSafe: true,
  };
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
