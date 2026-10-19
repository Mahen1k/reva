import { createHash } from "node:crypto";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import type { JavaScriptDeobfuscationResult } from "../../domain/javascript/javascriptDeobfuscation.js";
import { err, ok } from "../../domain/result.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { JavaScriptDeobfuscationService } from "./JavaScriptDeobfuscationService.js";

const artifactBytes = Buffer.from("fixture");
const file = {
  path: "/tmp/source.js",
  sha256: createHash("sha256").update(artifactBytes).digest("hex"),
  bytes: artifactBytes.length,
};
const provider = {
  id: "fixture-deobfuscator",
  name: "Fixture deobfuscator",
  version: "1",
} as const;
const result = (outputRoot = "/tmp/out"): JavaScriptDeobfuscationResult => {
  const artifact = (relativePath: string) => ({
    path: join(outputRoot, relativePath),
    sha256: file.sha256,
    bytes: file.bytes,
  });
  return {
    source: { ...file, published_copy: artifact("inputs/source.js") },
    options: { max_iterations: 16 },
    status: "unchanged",
    output: artifact("deobfuscated/source.js"),
    report: artifact("reports/js-redox.json"),
    manifest: artifact("manifest.json"),
    proof: {
      input_sha256: file.sha256,
      output_sha256: file.sha256,
    },
    analysis_input: {
      input_path: join(outputRoot, "deobfuscated"),
      format: "directory",
    },
    runtime_execution: "not-performed",
    limitations: [],
  };
};

const diagnostics = (outputRoot: string) => {
  const artifact = (relativePath: string) => ({
    path: join(outputRoot, relativePath),
    sha256: file.sha256,
    bytes: file.bytes,
    observed_bytes: file.bytes,
  });
  return {
    version: {
      exit_code: 0,
      exit_signal: null,
      truncated: false,
      stdout: artifact("diagnostics/version.stdout.txt"),
      stderr: artifact("diagnostics/version.stderr.txt"),
    },
    execution: {
      exit_code: 0,
      exit_signal: null,
      truncated: false,
      stdout: artifact("diagnostics/execution.stdout.txt"),
      stderr: artifact("diagnostics/execution.stderr.txt"),
    },
  };
};

const materializeResult = async (
  returned: JavaScriptDeobfuscationResult,
): Promise<void> => {
  const diagnosticFiles =
    returned.diagnostics === undefined
      ? []
      : [
          returned.diagnostics.version.stdout.path,
          returned.diagnostics.version.stderr.path,
          returned.diagnostics.execution.stdout.path,
          returned.diagnostics.execution.stderr.path,
        ];
  const files = [
    returned.source.published_copy.path,
    returned.output.path,
    returned.report.path,
    returned.manifest.path,
    ...diagnosticFiles,
  ];
  for (const path of files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, artifactBytes);
  }
  await mkdir(returned.analysis_input.input_path, { recursive: true });
};

it.each(["changed", "unchanged"] as const)(
  "rejects %s status that contradicts source/output digests",
  async (status) => {
    const returned = result();
    returned.status = status;
    if (status === "unchanged") {
      returned.output = { ...returned.output, sha256: "b".repeat(64) };
    }
    const service = new JavaScriptDeobfuscationService({
      deobfuscate: async () =>
        ok(
          createAnalysisExecution(returned, provider, {
            subject: {
              path: file.path,
              sha256: file.sha256,
              format: "javascript",
            },
          }),
        ),
    });
    const response = await service.deobfuscate({
      path: file.path,
      output_directory: "/tmp/out",
    });
    if (response.ok) throw new Error("expected status binding rejection");
    expect(response.error._tag).toBe("AnalysisOutputError");
  },
);
it.each([64, 15])(
  "rejects provider options=%s for a requested bound of one",
  async (maximum) => {
    const returned = result();
    returned.options.max_iterations = maximum;
    const service = new JavaScriptDeobfuscationService({
      deobfuscate: async () =>
        ok(
          createAnalysisExecution(returned, provider, {
            subject: {
              path: file.path,
              sha256: file.sha256,
              format: "javascript",
            },
          }),
        ),
    });
    const response = await service.deobfuscate({
      path: file.path,
      output_directory: "/tmp/out",
      max_iterations: 1,
    });
    if (response.ok) throw new Error("expected iteration binding rejection");
    expect(response.error._tag).toBe("AnalysisOutputError");
  },
);
it.each([
  { ...file, sha256: "b".repeat(64) },
  { ...file, bytes: file.bytes + 1 },
])("rejects a published source copy with mismatched metadata", async (copy) => {
  const returned = result();
  returned.source.published_copy = copy;
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () =>
      ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      ),
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: "/tmp/out",
  });
  if (response.ok) throw new Error("expected published source mismatch");
  expect(response.error._tag).toBe("AnalysisOutputError");
});
it("preserves provider failures", async () => {
  const failure = new AnalysisCapabilityUnavailableError(
    "js-redox",
    "deobfuscate_javascript_source",
    "fixture unavailable",
  );
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => err(failure),
  });
  expect(
    await service.deobfuscate({
      path: file.path,
      output_directory: "/tmp/out",
    }),
  ).toEqual(err(failure));
});

it("accepts canonical provider paths beneath a symlinked output parent", async () => {
  const root = await createTestTempDirectory("rea-js-service-output-link-");
  const canonicalParent = join(root, "canonical");
  const aliasParent = join(root, "alias");
  await mkdir(canonicalParent);
  await symlink(canonicalParent, aliasParent);
  const selectedOutput = join(aliasParent, "out");
  const canonicalOutput = join(await realpath(aliasParent), "out");
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      const returned = result(canonicalOutput);
      await materializeResult(returned);
      return ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: selectedOutput,
  });
  if (!response.ok) throw response.error;
  expect(response.value.subject?.format).toBe("javascript");
});

it("binds symlink-dotdot output semantics before provider execution", async () => {
  const root = await createTestTempDirectory("rea-js-service-output-dotdot-");
  const canonicalParent = join(root, "canonical");
  const child = join(canonicalParent, "child");
  const alias = join(root, "alias");
  await mkdir(child, { recursive: true });
  await symlink(child, alias);
  const selectedOutput = `${alias}/../out`;
  const canonicalOutput = join(canonicalParent, "out");
  let providerOutput: string | undefined;
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async (request) => {
      expect(Object.isFrozen(request)).toBe(true);
      providerOutput = request.output_directory;
      const returned = result(canonicalOutput);
      await materializeResult(returned);
      return ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: selectedOutput,
  });
  if (!response.ok) throw response.error;
  expect(providerOutput).toBe(canonicalOutput);
  expect(response.value.parameters).toMatchObject({
    output_directory: selectedOutput,
  });
});

it("carries normalized result limitations into Evidence", async () => {
  const root = await createTestTempDirectory("rea-js-service-limitations-");
  const output = join(root, "out");
  const returned = result(output);
  returned.limitations = ["provider-normalized caveat"];
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      await materializeResult(returned);
      return ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: output,
  });
  if (!response.ok) throw response.error;
  expect(response.value.limitations).toContain("provider-normalized caveat");
});

it("accepts a schema-valid result bound to JavaScript Evidence", async () => {
  const root = await createTestTempDirectory("rea-js-service-valid-");
  const output = join(root, "out");
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      const returned = result(output);
      await materializeResult(returned);
      return ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: output,
  });
  if (!response.ok) throw new Error("expected valid deobfuscation Evidence");
  if (response.value.subject === null)
    throw new Error("expected deobfuscation Evidence subject");
  expect(response.value.subject.format).toBe("javascript");
});

it.each([
  "invalid-result",
  "missing-subject",
  "subject-mismatch",
  "subject-format-mismatch",
  "proof-output-mismatch",
])("rejects %s returned across the provider boundary", async (mode) => {
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () =>
      ok(
        createAnalysisExecution(
          mode === "invalid-result"
            ? {}
            : mode === "proof-output-mismatch"
              ? {
                  ...result(),
                  proof: {
                    ...result().proof,
                    output_sha256: "b".repeat(64),
                  },
                }
              : result(),
          provider,
          mode === "missing-subject"
            ? {}
            : {
                subject: {
                  path: mode === "subject-mismatch" ? "/wrong.js" : file.path,
                  sha256: file.sha256,
                  format:
                    mode === "subject-format-mismatch"
                      ? ("pe" as const)
                      : ("javascript" as const),
                },
              },
        ),
      ),
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: "/tmp/out",
  });
  if (response.ok) throw new Error("expected invalid provider output");
  expect(response.error._tag).toBe("AnalysisOutputError");
});

it.each([
  "source-copy",
  "output",
  "report",
  "manifest",
  "analysis-input",
] as const)("rejects a relative returned %s path", async (field) => {
  const returned = result();
  switch (field) {
    case "source-copy":
      returned.source.published_copy.path = "out/inputs/source.js";
      break;
    case "output":
      returned.output.path = "out/deobfuscated/source.js";
      break;
    case "report":
      returned.report.path = "out/reports/js-redox.json";
      break;
    case "manifest":
      returned.manifest.path = "out/manifest.json";
      break;
    case "analysis-input":
      returned.analysis_input.input_path = "out/deobfuscated";
      break;
  }
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () =>
      ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      ),
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: "/tmp/out",
  });
  if (response.ok) throw new Error("expected relative provider path rejection");
  expect(response.error._tag).toBe("AnalysisOutputError");
});

it("rejects an analysis handoff that does not name the transformed file directory", async () => {
  const returned = result();
  returned.analysis_input.input_path = "/tmp/out/inputs";
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () =>
      ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      ),
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: "/tmp/out",
  });
  if (response.ok) throw new Error("expected analysis handoff rejection");
  expect(response.error._tag).toBe("AnalysisOutputError");
});

it.each(["path", "output_directory"])(
  "rejects relative %s before invoking the provider",
  async (field) => {
    let invoked = false;
    const service = new JavaScriptDeobfuscationService({
      deobfuscate: async () => {
        invoked = true;
        return ok(createAnalysisExecution(result(), provider));
      },
    });
    const response = await service.deobfuscate({
      path: file.path,
      output_directory: "/tmp/out",
      [field]: "relative.js",
    });
    expect(invoked).toBe(false);
    if (response.ok) throw new Error("expected invalid path");
    expect(response.error._tag).toBe("AnalysisInputError");
  },
);

it("returns a typed input error when the output parent is unavailable", async () => {
  const root = await createTestTempDirectory("rea-js-service-missing-parent-");
  let invoked = false;
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      invoked = true;
      return ok(createAnalysisExecution(result(), provider));
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: join(root, "missing", "out"),
  });
  expect(invoked).toBe(false);
  if (response.ok) throw new Error("expected invalid output parent");
  expect(response.error._tag).toBe("AnalysisInputError");
  expect(response.error).toMatchObject({
    issues: [expect.objectContaining({ path: ["output_directory"] })],
  });
});

it("rejects returned artifact paths that traverse an output-tree symlink", async () => {
  const root = await createTestTempDirectory("rea-js-service-returned-link-");
  const output = join(root, "out");
  const external = join(root, "external");
  await mkdir(external);
  const returned = result(output);
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async (request) => {
      await materializeResult(returned);
      await writeFile(join(external, "source.js"), "fixture");
      await symlink(external, join(request.output_directory, "escape"));
      returned.output.path = join(
        request.output_directory,
        "escape",
        "source.js",
      );
      returned.analysis_input.input_path = join(
        request.output_directory,
        "escape",
      );
      return ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: output,
  });
  if (response.ok) throw new Error("expected symlink traversal rejection");
  expect(response.error._tag).toBe("AnalysisOutputError");
});

it("rejects provider results whose advertised artifacts do not exist", async () => {
  const root = await createTestTempDirectory(
    "rea-js-service-missing-artifact-",
  );
  const output = join(root, "out");
  const returned = result(output);
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      await mkdir(output, { recursive: true });
      return ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: output,
  });
  if (response.ok) throw new Error("expected nonexistent artifact rejection");
  expect(response.error._tag).toBe("AnalysisOutputError");
});

it("rejects diagnostic artifact paths outside the selected output tree", async () => {
  const root = await createTestTempDirectory("rea-js-service-diagnostic-path-");
  const output = join(root, "out");
  const external = join(root, "external-version-stdout.txt");
  const returned = result(output);
  returned.diagnostics = diagnostics(output);
  returned.diagnostics.version.stdout.path = external;
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      await materializeResult(returned);
      return ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: output,
  });
  if (response.ok) throw new Error("expected diagnostic path rejection");
  expect(response.error._tag).toBe("AnalysisOutputError");
});

it("derives shipped-artifact locations and drops untrusted provider raw results", async () => {
  const root = await createTestTempDirectory(
    "rea-js-service-provider-metadata-",
  );
  const output = join(root, "out");
  const returned = result(output);
  const external = join(root, "untrusted.txt");
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      await materializeResult(returned);
      return ok(
        createAnalysisExecution(returned, provider, {
          rawResult: { untrusted_path: external },
          locations: [{ kind: "artifact-path", path: external }],
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: output,
  });
  if (!response.ok) throw response.error;
  expect(response.value.raw_result).toBeNull();
  expect(response.value.locations).toEqual([
    { kind: "artifact-path", path: file.path },
    { kind: "artifact-path", path: returned.output.path },
    { kind: "artifact-path", path: returned.report.path },
  ]);
});

it.each([
  {
    name: "nonzero exit",
    mutate: (returned: JavaScriptDeobfuscationResult) => {
      if (returned.diagnostics === undefined)
        throw new Error("missing diagnostics");
      returned.diagnostics.execution.exit_code = 23;
    },
  },
  {
    name: "observed bytes below retained bytes",
    mutate: (returned: JavaScriptDeobfuscationResult) => {
      if (returned.diagnostics === undefined)
        throw new Error("missing diagnostics");
      returned.diagnostics.execution.stdout.observed_bytes =
        returned.diagnostics.execution.stdout.bytes - 1;
    },
  },
  {
    name: "untruncated missing bytes",
    mutate: (returned: JavaScriptDeobfuscationResult) => {
      if (returned.diagnostics === undefined)
        throw new Error("missing diagnostics");
      returned.diagnostics.execution.stdout.observed_bytes =
        returned.diagnostics.execution.stdout.bytes + 1;
    },
  },
])("rejects inconsistent normalized diagnostics: $name", async ({ mutate }) => {
  const root = await createTestTempDirectory("rea-js-service-bad-diagnostics-");
  const output = join(root, "out");
  const returned = result(output);
  returned.diagnostics = diagnostics(output);
  mutate(returned);
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      await materializeResult(returned);
      return ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: output,
  });
  if (response.ok)
    throw new Error("expected inconsistent diagnostics rejection");
  expect(response.error._tag).toBe("AnalysisOutputError");
});

it("observes cancellation after provider success before physical path verification", async () => {
  const root = await createTestTempDirectory(
    "rea-js-service-post-provider-abort-",
  );
  const output = join(root, "out");
  const returned = result(output);
  const controller = new AbortController();
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      await materializeResult(returned);
      controller.abort("fixture cancellation");
      return ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
  });
  const response = await service.deobfuscate(
    { path: file.path, output_directory: output },
    { signal: controller.signal },
  );
  if (response.ok) throw new Error("expected cancellation");
  expect(response.error._tag).toBe("AnalysisCancelledError");
  expect(response.error.cause).toBe("fixture cancellation");
});

it("preserves the exact reason of a request cancelled before admission", async () => {
  const reason = Object.freeze({ kind: "fixture-cancellation", nonce: 17 });
  const controller = new AbortController();
  controller.abort(reason);
  let invoked = false;
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      invoked = true;
      throw new Error("provider must not run for pre-cancelled work");
    },
  });
  const response = await service.deobfuscate(
    { path: file.path, output_directory: "/tmp/out" },
    { signal: controller.signal },
  );
  if (response.ok) throw new Error("expected cancellation");
  expect(response.error._tag).toBe("AnalysisCancelledError");
  expect(response.error.cause).toBe(reason);
  expect(invoked).toBe(false);
});

it("returns typed cancellation instead of throwing for work admitted after close", async () => {
  let invoked = false;
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      invoked = true;
      throw new Error("closed service must not invoke provider");
    },
  });
  await service.close();
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: "/tmp/out",
  });
  if (response.ok) throw new Error("expected closed-service cancellation");
  expect(response.error._tag).toBe("AnalysisCancelledError");
  expect(invoked).toBe(false);
});

it("drains an admitted request through artifact verification before close completes", async () => {
  const root = await createTestTempDirectory("rea-js-service-close-race-");
  const output = join(root, "out");
  const returned = result(output);
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  let reportProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    reportProviderStarted = resolve;
  });
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      reportProviderStarted();
      await providerGate;
      await materializeResult(returned);
      return ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
    close: async () => undefined,
  });

  const operation = service.deobfuscate({
    path: file.path,
    output_directory: output,
  });
  await providerStarted;
  let closeCompleted = false;
  const closing = service.close().then(() => {
    closeCompleted = true;
  });
  await Promise.resolve();
  expect(closeCompleted).toBe(false);

  releaseProvider();
  const response = await operation;
  if (!response.ok) throw response.error;
  await closing;
  expect(closeCompleted).toBe(true);
  expect(response.value.subject?.format).toBe("javascript");
});

it.each([
  [
    "published source",
    (returned: JavaScriptDeobfuscationResult) =>
      returned.source.published_copy.path,
  ],
  ["output", (returned: JavaScriptDeobfuscationResult) => returned.output.path],
  ["report", (returned: JavaScriptDeobfuscationResult) => returned.report.path],
  [
    "manifest",
    (returned: JavaScriptDeobfuscationResult) => returned.manifest.path,
  ],
])(
  "rejects %s bytes that disagree with provider metadata",
  async (_name, selectedPath) => {
    const root = await createTestTempDirectory("rea-js-service-byte-binding-");
    const output = join(root, "out");
    const returned = result(output);
    const service = new JavaScriptDeobfuscationService({
      deobfuscate: async () => {
        await materializeResult(returned);
        await writeFile(selectedPath(returned), "tampered");
        return ok(
          createAnalysisExecution(returned, provider, {
            subject: {
              path: file.path,
              sha256: file.sha256,
              format: "javascript",
            },
          }),
        );
      },
    });
    const response = await service.deobfuscate({
      path: file.path,
      output_directory: output,
    });
    if (response.ok) throw new Error("expected physical artifact mismatch");
    expect(response.error._tag).toBe("AnalysisOutputError");
  },
);

it("rejects diagnostic bytes that disagree with provider metadata", async () => {
  const root = await createTestTempDirectory(
    "rea-js-service-diagnostic-bytes-",
  );
  const output = join(root, "out");
  const returned = result(output);
  returned.diagnostics = diagnostics(output);
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      await materializeResult(returned);
      if (returned.diagnostics === undefined)
        throw new Error("missing diagnostics");
      await writeFile(returned.diagnostics.execution.stderr.path, "tampered");
      return ok(
        createAnalysisExecution(returned, provider, {
          subject: {
            path: file.path,
            sha256: file.sha256,
            format: "javascript",
          },
        }),
      );
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: output,
  });
  if (response.ok) throw new Error("expected diagnostic byte mismatch");
  expect(response.error._tag).toBe("AnalysisOutputError");
});

it("snapshots the provider subject exactly once before filesystem verification", async () => {
  const root = await createTestTempDirectory(
    "rea-js-service-subject-snapshot-",
  );
  const output = join(root, "out");
  const returned = result(output);
  let subjectReads = 0;
  const goodSubject = {
    path: file.path,
    sha256: file.sha256,
    format: "javascript" as const,
  };
  const badSubject = { ...goodSubject, sha256: "f".repeat(64) };
  const service = new JavaScriptDeobfuscationService({
    deobfuscate: async () => {
      await materializeResult(returned);
      const execution = createAnalysisExecution(returned, provider, {
        subject: goodSubject,
      });
      Object.defineProperty(execution, "subject", {
        configurable: true,
        enumerable: true,
        get: () => {
          subjectReads += 1;
          return subjectReads === 1 ? goodSubject : badSubject;
        },
      });
      return ok(execution);
    },
  });
  const response = await service.deobfuscate({
    path: file.path,
    output_directory: output,
  });
  if (!response.ok) throw response.error;
  expect(subjectReads).toBe(1);
  expect(response.value.subject?.digest.sha256).toBe(file.sha256);
});
