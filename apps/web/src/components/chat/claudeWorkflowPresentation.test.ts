import { describe, expect, it } from "vite-plus/test";

import {
  claudeWorkflowScriptFromToolInput,
  formatClaudeWorkflowFoldLabel,
  parseClaudeWorkflowScriptMeta,
} from "./claudeWorkflowPresentation.ts";

describe("parseClaudeWorkflowScriptMeta", () => {
  it("extracts the workflow identity and declared phases without evaluating the script", () => {
    const script = `
      export const meta = {
        name: "sandbox-project-survey",
        description: 'Survey the project before proposing changes.',
        phases: [
          { title: "Survey", detail: "Inspect the relevant packages in parallel." },
          { title: "Synthesize", detail: "Combine findings into one recommendation." },
        ],
      } as const;

      throw new Error("Parsing must never execute this code");
    `;

    expect(parseClaudeWorkflowScriptMeta(script)).toEqual({
      name: "sandbox-project-survey",
      description: "Survey the project before proposing changes.",
      phases: [
        { title: "Survey", detail: "Inspect the relevant packages in parallel." },
        { title: "Synthesize", detail: "Combine findings into one recommendation." },
      ],
    });
  });

  it("returns null for malformed or unrelated scripts", () => {
    expect(parseClaudeWorkflowScriptMeta("export const run = () => 1")).toBeNull();
    expect(parseClaudeWorkflowScriptMeta("export const meta = { name: getName() }")).toBeNull();
  });

  it("ignores declaration-shaped text outside a top-level statement", () => {
    const script = [
      '// export const meta = { name: "line-comment-decoy" };',
      '/* export const meta = { name: "block-comment-decoy" }; */',
      "const quoted = \"export const meta = { name: 'string-decoy' }\";",
      'const templated = `export const meta = { name: "template-decoy" }`;',
      'const matched = /export const meta = \\{ name: "regex-decoy" \\}/;',
      "function nested() {",
      '  const exportText = "ignored";',
      "}",
      "export /* keep comments legal */ const meta /* here too */ = {",
      '  name: "real-workflow",',
      '  phases: [{ title: "Run" }],',
      "};",
    ].join("\n");

    expect(parseClaudeWorkflowScriptMeta(script)).toEqual({
      name: "real-workflow",
      phases: [{ title: "Run" }],
    });
    expect(
      parseClaudeWorkflowScriptMeta('// export const meta = { name: "comment-only" };'),
    ).toBeNull();
  });

  it("accepts a typed metadata declaration", () => {
    expect(
      parseClaudeWorkflowScriptMeta(`
        export const meta: Readonly<{
          name: string;
          phases: ReadonlyArray<{ title: string }>;
        }> = {
          name: "typed-workflow",
          phases: [{ title: "Verify" }],
        };
      `),
    ).toEqual({
      name: "typed-workflow",
      phases: [{ title: "Verify" }],
    });
  });
});

describe("claudeWorkflowScriptFromToolInput", () => {
  it("only exposes script input from the Workflow tool", () => {
    expect(
      claudeWorkflowScriptFromToolInput("Workflow", {
        script: "export const meta = { name: 'survey' }",
      }),
    ).toContain("survey");
    expect(claudeWorkflowScriptFromToolInput("Bash", { script: "echo unsafe" })).toBeNull();
    expect(claudeWorkflowScriptFromToolInput("Workflow", { prompt: "missing" })).toBeNull();
  });
});

describe("formatClaudeWorkflowFoldLabel", () => {
  it("names a single workflow and aggregates multiple workflows without hiding any", () => {
    expect(
      formatClaudeWorkflowFoldLabel("Worked for 2s", [
        {
          name: "sandbox-project-survey",
          agentCount: 4,
          startedAt: "2026-09-04T00:00:00.000Z",
          completedAt: "2026-09-04T00:01:41.000Z",
        },
      ]),
    ).toBe("Workflow sandbox-project-survey · 4 agents · 1m 41s");
    expect(
      formatClaudeWorkflowFoldLabel("Worked for 2m", [
        {
          name: "survey",
          agentCount: 3,
          startedAt: "2026-09-04T00:00:00.000Z",
          completedAt: "2026-09-04T00:01:00.000Z",
        },
        {
          name: "verify",
          agentCount: 2,
          startedAt: "2026-09-04T00:01:00.000Z",
          completedAt: "2026-09-04T00:02:00.000Z",
        },
      ]),
    ).toBe("2 workflows · 5 agents · 2m");
    expect(
      formatClaudeWorkflowFoldLabel(
        "Worked for 2s",
        [
          {
            name: "still-running",
            agentCount: 1,
            startedAt: "2026-09-04T00:00:00.000Z",
            completedAt: null,
          },
        ],
        Date.parse("2026-09-04T00:01:41.000Z"),
      ),
    ).toBe("Workflow still-running · 1 agent · 1m 41s");
  });
});
