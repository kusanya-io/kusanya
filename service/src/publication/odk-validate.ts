/** Bounded ODK Validate process boundary. No downloads or runtime discovery. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Diagnostic } from '../compiler/types.js';

export const odkValidate120Sha256 =
  '92756ea4aed195355a07e5572f025f0921a31282387a870ae63e1f5cdf37e0c3';

const maxJarBytes = 64 * 1024 * 1024;
const maxOutputBytes = 1024 * 1024;
const timeoutMs = 60_000;

export type XFormValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

export type ValidateXForm = (xml: string) => Promise<XFormValidationResult>;

export interface OdkValidateConfiguration {
  readonly javaExecutable: string;
  readonly jarPath: string;
}

export type BoundedProcessOutcome =
  'exit-zero' | 'exit-nonzero' | 'infrastructure';

export interface BoundedProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

const accepted = Object.freeze({ ok: true } as const);
const refused = (code: string, location: string): XFormValidationResult =>
  Object.freeze({
    ok: false,
    diagnostic: Object.freeze({ code, location }),
  });

function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
}

async function reviewedJar(path: string): Promise<Buffer | undefined> {
  const details = await stat(path);
  if (!details.isFile() || details.size > maxJarBytes) return undefined;
  const bytes = await readFile(path);
  if (bytes.byteLength > maxJarBytes) return undefined;
  return createHash('sha256').update(bytes).digest('hex') ===
    odkValidate120Sha256
    ? bytes
    : undefined;
}

/** Run a non-shell child while counting and discarding all output. */
export async function runBoundedProcess(
  request: BoundedProcessRequest,
): Promise<BoundedProcessOutcome> {
  if (
    !isAbsolute(request.executable) ||
    !isAbsolute(request.cwd) ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > timeoutMs ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes < 1 ||
    request.maxOutputBytes > maxOutputBytes
  )
    return 'infrastructure';
  return await new Promise((resolveOutcome) => {
    let settled = false;
    let outputBytes = 0;
    let forcedFailure = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    const finish = (outcome: BoundedProcessOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      resolveOutcome(outcome);
    };
    const child = spawn(request.executable, request.arguments, {
      cwd: request.cwd,
      env: childEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stopForFailure = (): void => {
      forcedFailure = true;
      child.kill();
      terminationTimer = setTimeout(() => finish('infrastructure'), 5_000);
      terminationTimer.unref();
    };
    const countOutput = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > request.maxOutputBytes && !forcedFailure)
        stopForFailure();
    };
    child.stdout.on('data', countOutput);
    child.stderr.on('data', countOutput);
    child.once('error', () => finish('infrastructure'));
    child.once('close', (code, signal) => {
      if (forcedFailure || signal || code === null) finish('infrastructure');
      else finish(code === 0 ? 'exit-zero' : 'exit-nonzero');
    });
    const timer = setTimeout(stopForFailure, request.timeoutMs);
    timer.unref();
  });
}

/**
 * Construct the only concrete publish-time validator. Configuration is explicit;
 * the adapter never searches for, downloads or substitutes Java or the validator.
 */
export function createOdkValidateValidator(
  configuration: OdkValidateConfiguration,
): ValidateXForm {
  const javaExecutable = configuration.javaExecutable;
  const jarPath = configuration.jarPath;
  return async (xml) => {
    if (
      !isAbsolute(javaExecutable) ||
      !isAbsolute(jarPath) ||
      typeof xml !== 'string'
    )
      return refused('PUBLICATION_VALIDATOR_CONFIGURATION', 'validator');

    let directory: string | undefined;
    let result: XFormValidationResult;
    try {
      const jarBytes = await reviewedJar(jarPath);
      if (jarBytes === undefined)
        return refused('PUBLICATION_VALIDATOR_PIN', 'validator');
      directory = await mkdtemp(join(tmpdir(), 'kusanya-odk-validate-'));
      const reviewedJarPath = join(directory, 'ODK-Validate-v1.20.0.jar');
      const xformPath = join(directory, 'form.xml');
      await writeFile(reviewedJarPath, jarBytes, { mode: 0o600 });
      await writeFile(xformPath, xml, { encoding: 'utf8', mode: 0o600 });
      const outcome = await runBoundedProcess({
        executable: javaExecutable,
        arguments: [
          '-Xmx256m',
          '-Djava.awt.headless=true',
          '-jar',
          reviewedJarPath,
          xformPath,
        ],
        cwd: dirname(xformPath),
        timeoutMs,
        maxOutputBytes,
      });
      result =
        outcome === 'exit-zero'
          ? accepted
          : outcome === 'exit-nonzero'
            ? refused('PUBLICATION_XFORM_INVALID', 'xform')
            : refused('PUBLICATION_VALIDATOR_FAILURE', 'validator');
    } catch {
      result = refused('PUBLICATION_VALIDATOR_FAILURE', 'validator');
    } finally {
      if (directory !== undefined) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          result = refused('PUBLICATION_VALIDATOR_CLEANUP', 'validator');
        }
      }
    }
    return result;
  };
}
