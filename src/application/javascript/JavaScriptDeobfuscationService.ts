import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
} from "../../artifacts/ArtifactFileOperation.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  javascriptDeobfuscationInputSchema,
  javascriptDeobfuscationResultSchema,
} from "../../domain/javascript/javascriptDeobfuscation.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";
import { absoluteCallerPath } from "../../filesystem/callerPath.js";
import { err, ok, type Result } from "../../domain/result.js";
import { ABORTED, waitForAbortable } from "../../process/AbortablePromise.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { JavaScriptDeobfuscationPort } from "./JavaScriptDeobfuscationPort.js";

const OPERATION = "deobfuscate_javascript_source";

/** Shared CLI/MCP validation and Evidence for proof-gated JavaScript rewriting. */
export class JavaScriptDeobfuscationService {
  readonly #verificationResources = new ArtifactResourceScope();
  #closing = false;

  constructor(readonly provider: JavaScriptDeobfuscationPort) {}

  async close(): Promise<void> {
    this.#closing = true;
    const results = await Promise.allSettled([
      this.provider.close?.() ?? Promise.resolve(),
      this.#verificationResources.close(),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "JavaScript deobfuscation cleanup failed",
      );
  }

  async deobfuscate(
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (this.#closing)
      return err(
        new AnalysisCancelledError(OPERATION, {
          cause:
            options?.signal?.aborted === true
              ? options.signal.reason
              : undefined,
        }),
      );
    try {
      return await this.#verificationResources.run(() =>
        this.#deobfuscate(input, options),
      );
    } catch (cause: unknown) {
      if (this.#closing)
        return err(
          new AnalysisCancelledError(OPERATION, {
            cause:
              options?.signal?.aborted === true ? options.signal.reason : cause,
          }),
        );
      if (cause instanceof ArtifactReaderFailure) {
        const failure = new AnalysisOutputError(
          OPERATION,
          "Artifact verification cleanup from a previous request remains incomplete.",
          { cause },
        );
        bindArtifactFileCleanup(cause, failure);
        return err(failure);
      }
      throw cause;
    }
  }

  async #deobfuscate(
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (isAborted(options?.signal))
      return err(
        new AnalysisCancelledError(OPERATION, {
          cause: options?.signal?.reason,
        }),
      );
    const parsed = javascriptDeobfuscationInputSchema.safeParse(input);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, parsed.error.issues, input, {
          cause: parsed.error,
        }),
      );
    const invalidPaths = (["path", "output_directory"] as const).filter(
      (field) => !isAbsolute(parsed.data[field]),
    );
    if (invalidPaths.length > 0)
      return err(
        new AnalysisInputError(
          OPERATION,
          undefined,
          invalidPaths.map((field) => ({
            path: [field],
            reason: "invalid_format",
            message: `${field} must be an absolute filesystem path on this host.`,
          })),
        ),
      );
    const selected = Object.freeze({ ...parsed.data });
    let outputRoot: string;
    try {
      outputRoot = await canonicalOutputRoot(selected.output_directory);
    } catch (cause: unknown) {
      return err(
        new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["output_directory"],
            reason: "invalid_value",
            message:
              "output_directory must have an existing searchable parent directory.",
          },
        ]),
      );
    }
    const providerInput = Object.freeze({
      ...selected,
      output_directory: outputRoot,
    });
    const execution = await this.provider.deobfuscate(providerInput, options);
    if (!execution.ok) return execution;
    const returnedSubject = execution.value.subject;
    const subject =
      returnedSubject === null ? null : Object.freeze({ ...returnedSubject });
    const executionProvider = Object.freeze({ ...execution.value.provider });
    const executionLimitations = Object.freeze([
      ...execution.value.limitations,
    ]);
    const result = javascriptDeobfuscationResultSchema.safeParse(
      execution.value.result,
    );
    if (!result.success || subject === null)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Deobfuscation did not return a valid result bound to the original source",
        ),
      );
    const diagnostics = result.data.diagnostics;
    const diagnosticFiles =
      diagnostics === undefined
        ? []
        : [
            diagnostics.version.stdout,
            diagnostics.version.stderr,
            diagnostics.execution.stdout,
            diagnostics.execution.stderr,
          ];
    const publishedFiles: ReturnedArtifactFile[] = [
      result.data.source.published_copy,
      result.data.output,
      result.data.report,
      result.data.manifest,
      ...diagnosticFiles,
    ];
    const publishedPaths = [
      ...publishedFiles.map(({ path }) => path),
      result.data.analysis_input.input_path,
    ];
    if (
      result.data.source.path !== selected.path ||
      result.data.source.published_copy.sha256 !== result.data.source.sha256 ||
      result.data.source.published_copy.bytes !== result.data.source.bytes ||
      result.data.proof.input_sha256 !== result.data.source.sha256 ||
      result.data.proof.output_sha256 !== result.data.output.sha256 ||
      subject.path !== result.data.source.path ||
      subject.sha256 !== result.data.source.sha256 ||
      result.data.options.max_iterations !== selected.max_iterations ||
      (result.data.status === "unchanged") !==
        (result.data.source.sha256 === result.data.output.sha256) ||
      subject.format !== "javascript" ||
      publishedPaths.some(
        (path) => !isAbsolute(path) || !isWithin(outputRoot, path),
      ) ||
      result.data.analysis_input.input_path !== dirname(result.data.output.path)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Deobfuscation source, published artifacts, output status, or iteration bound disagrees with its Evidence binding",
        ),
      );
    let publishedArtifactsValid: boolean | typeof ABORTED;
    try {
      publishedArtifactsValid = await verifyReturnedArtifacts(
        outputRoot,
        publishedFiles,
        result.data.analysis_input.input_path,
        options?.signal,
        this.#verificationResources,
      );
    } catch (cause: unknown) {
      if (
        cause instanceof ArtifactReaderFailure &&
        cause.reason === "cancelled"
      ) {
        const cancellation = new AnalysisCancelledError(OPERATION, {
          cause:
            options?.signal?.aborted === true
              ? options.signal.reason
              : artifactFileCancellationCause(cause),
        });
        bindArtifactFileCleanup(cause, cancellation);
        return err(cancellation);
      }
      const failure = new AnalysisOutputError(
        OPERATION,
        "Deobfuscation returned artifacts that could not be physically verified against their advertised identity",
        { cause },
      );
      bindArtifactFileCleanup(cause, failure);
      return err(failure);
    }
    if (publishedArtifactsValid === ABORTED)
      return err(
        new AnalysisCancelledError(OPERATION, {
          cause: options?.signal?.reason,
        }),
      );
    if (!publishedArtifactsValid)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Deobfuscation returned artifacts that escape, alias, or disagree with their advertised bytes",
        ),
      );
    const evidence = createEvidence(subject, executionProvider, {
      operation: OPERATION,
      parameters: jsonObjectSchema.parse(selected),
      result: jsonObjectSchema.parse(result.data),
      locations: [
        { kind: "artifact-path", path: selected.path },
        { kind: "artifact-path", path: result.data.output.path },
        { kind: "artifact-path", path: result.data.report.path },
      ],
      limitations: [
        ...new Set([...result.data.limitations, ...executionLimitations]),
      ],
      confidence: "derived",
      authority: "shipped-artifact",
    });
    if (isAborted(options?.signal))
      return err(
        new AnalysisCancelledError(OPERATION, {
          cause: options?.signal?.reason,
          partialObservation: evidence,
        }),
      );
    return ok(evidence);
  }
}

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const canonicalOutputRoot = async (path: string): Promise<string> => {
  const requested = absoluteCallerPath(path);
  return join(await realpath(dirname(requested)), basename(requested));
};

const isWithin = (root: string, path: string): boolean => {
  const candidate = resolve(path);
  const child = relative(root, candidate);
  return (
    child === "" ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
  );
};

interface ReturnedArtifactFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

const returnedPathsStayWithin = async (
  root: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<boolean | typeof ABORTED> => {
  const canonicalRoot = await waitForAbortable(realpath(root), signal);
  if (canonicalRoot === ABORTED) return ABORTED;
  if (canonicalRoot !== resolve(root)) return false;
  for (const path of paths) {
    const lexicalPath = resolve(path);
    if (!isAbsolute(path) || !isWithin(root, lexicalPath)) return false;
    const canonicalPath = await waitForAbortable(realpath(path), signal);
    if (canonicalPath === ABORTED) return ABORTED;
    if (
      canonicalPath !== lexicalPath ||
      !isWithin(canonicalRoot, canonicalPath)
    )
      return false;
  }
  return true;
};

const verifyReturnedArtifacts = async (
  root: string,
  files: readonly ReturnedArtifactFile[],
  analysisInputPath: string,
  signal: AbortSignal | undefined,
  resources: ArtifactResourceScope,
): Promise<boolean | typeof ABORTED> => {
  const paths = [...files.map(({ path }) => path), analysisInputPath];
  const before = await returnedPathsStayWithin(root, paths, signal);
  if (before !== true) return before;
  for (const file of files) {
    const observed = await readStableArtifact(
      file.path,
      file.bytes,
      signal,
      undefined,
      resources,
    );
    if (observed.bytes.length !== file.bytes || observed.sha256 !== file.sha256)
      return false;
  }
  return returnedPathsStayWithin(root, paths, signal);
};
