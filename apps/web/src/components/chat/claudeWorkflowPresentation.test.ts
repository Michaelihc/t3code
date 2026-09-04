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
      formatClaudeWorkflowFoldLabel("Worked for 1m 41s", [
        { name: "sandbox-project-survey", agentCount: 4 },
      ]),
    ).toBe("Workflow sandbox-project-survey · 4 agents · 1m 41s");
    expect(
      formatClaudeWorkflowFoldLabel("Worked for 2m", [
        { name: "survey", agentCount: 3 },
        { name: "verify", agentCount: 2 },
      ]),
    ).toBe("2 workflows · 5 agents · 2m");
  });
});
