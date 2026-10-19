import { createPackageWithOptions } from "@electron/asar";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "keeps retained directory identities inside their artifact container through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-package-directory-owner-");
    const application = join(root, "application");
    const source = join(root, "source");
    await mkdir(join(application, "node_modules/outer-empty"), {
      recursive: true,
    });
    await mkdir(join(source, "node_modules/inner-empty"), { recursive: true });
    await writeFixtureFiles(source, {
      "entry.mjs":
        'import "outer-empty"; import "inner-empty"; import "local/../..";',
      "entry.cjs": 'require("outer-empty"); require("inner-empty");',
      "node_modules/local/package.json": "{}",
    });
    const archive = join(application, "app.asar");
    await createPackageWithOptions(source, archive, {});
    const original = await readFile(archive);
    const { graph } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      application,
    );
    for (const mode of ["import", "require"])
      for (const [specifier, status] of [
        ["outer-empty", "external"],
        ["inner-empty", "not-found"],
      ])
        expect(graph.edges).toContainEqual(
          expect.objectContaining({
            relation: "imports",
            properties: expect.objectContaining({
              module_link_kind: mode,
              specifier,
              resolution_status: status,
              resolved_path: null,
            }),
          }),
        );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "imports",
        properties: expect.objectContaining({
          module_link_kind: "import",
          specifier: "local/../..",
          resolution_status: "rejected",
          resolved_path: null,
        }),
      }),
    );
    expect(await readFile(archive)).toEqual(original);
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "recognizes the artifact root without package metadata or an index through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-package-root-directory-");
    await writeFixtureFiles(root, {
      "entry.mjs": 'import "local/../..";',
      "node_modules/local/package.json": "{}",
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "imports",
        properties: expect.objectContaining({
          specifier: "local/../..",
          resolution_status: "rejected",
          resolved_path: null,
        }),
        evidence: expect.objectContaining({
          limitations: expect.arrayContaining([
            expect.stringContaining("directory imports are unsupported"),
          ]),
        }),
      }),
    );
  },
);

cliTest.skipIf(process.platform === "win32").for(["CLI", "stdio MCP"] as const)(
  "preserves unknown symlink targets during package main finalization through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-package-main-symlink-");
    const application = join(root, "application");
    const source = join(root, "source");
    await mkdir(application);
    await writeFixtureFiles(source, {
      "entry.mjs":
        'import "linked"; import "linked-probe"; import "./alias/target.js";',
      "entry.cjs": 'require("linked"); require("linked-probe");',
      "node_modules/linked/package.json": '{"main":"./lib/"}',
      "node_modules/linked/lib.js": "module.exports = 1;",
      "node_modules/linked/lib/target.js": "module.exports = 2;",
      "node_modules/linked/lib/index.js": "module.exports = 3;",
      "node_modules/linked/index.js": "module.exports = 4;",
      "node_modules/linked-probe/package.json": '{"main":"./lib"}',
      "node_modules/linked-probe/lib.js": "module.exports = 5;",
      "node_modules/linked-probe/index.js": "module.exports = 6;",
    });
    await symlink("target.js", join(source, "node_modules/linked/lib/.js"));
    await symlink("lib.js", join(source, "node_modules/linked-probe/lib"));
    await symlink("node_modules/linked/lib", join(source, "alias"), "dir");
    const archive = join(application, "app.asar");
    await createPackageWithOptions(source, archive, {});
    const original = await readFile(archive);
    const { graph } = await analyzeJavaScriptDirectory(
      surface,
      cli,
      application,
    );
    for (const [mode, specifier, candidate] of [
      ["import", "linked", "node_modules/linked/lib/.js"],
      ["import", "linked-probe", "node_modules/linked-probe/lib"],
      ["require", "linked-probe", "node_modules/linked-probe/lib"],
      ["import", "./alias/target.js", "alias/target.js"],
    ])
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          relation: "imports",
          properties: expect.objectContaining({
            module_link_kind: mode,
            specifier,
            resolution_status: "unavailable",
            resolved_path: null,
            candidate_path: `app.asar/${candidate}`,
          }),
          evidence: expect.objectContaining({
            limitations: expect.arrayContaining([
              expect.stringContaining("symbolic link"),
            ]),
          }),
        }),
      );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "imports",
        properties: expect.objectContaining({
          module_link_kind: "require",
          specifier: "linked",
          resolution_status: "resolved",
          resolved_path: "app.asar/node_modules/linked/lib.js",
        }),
      }),
    );
    expect(await readFile(archive)).toEqual(original);
  },
);
