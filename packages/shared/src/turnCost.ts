import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";

/** Child entries include their descendants; never add grandchildren a second time. */
export function summarizeTurnCost(turn: OrchestrationV2ProviderTurn) {
  const children = turn.subagentCosts ?? [];
  const main = turn.turnCost?.amountUsd;
  const priced = children.filter((child) => child.amountUsd !== null);
  const subagents = priced.reduce((sum, child) => sum + child.amountUsd!, 0);
  const expected = Math.max(turn.subagentCount ?? 0, turn.turnTokenUsage?.hasSubagents ? 1 : 0);
  const observed = new Set(children.map((child) => child.providerThreadId)).size;
  return {
    amountUsd: main === undefined && priced.length === 0 ? null : (main ?? 0) + subagents,
    subagentAmountUsd: subagents,
    estimated: turn.turnCost?.source === "modelPriced" || children.some((child) => child.estimated),
    complete:
      main !== undefined &&
      (turn.turnCost?.source === "providerReported" ||
        turn.turnTokenUsage?.usageStatus === "complete") &&
      turn.status !== "running" &&
      turn.status !== "pending" &&
      observed >= expected &&
      children.every((child) => child.complete),
    hasSubagents: expected > 0 || children.length > 0,
  };
}

/** Late status/context updates must not erase persisted accounting. */
export function preserveTurnAccounting(
  current: OrchestrationV2ProviderTurn | undefined,
  next: OrchestrationV2ProviderTurn,
) {
  return {
    ...next,
    ...((next.costModel ?? current?.costModel)
      ? { costModel: next.costModel ?? current?.costModel }
      : {}),
    ...((next.costParent ?? current?.costParent)
      ? { costParent: next.costParent ?? current?.costParent }
      : {}),
    ...((next.subagentCount ?? current?.subagentCount) === undefined
      ? {}
      : { subagentCount: next.subagentCount ?? current?.subagentCount }),
    ...((next.subagentCosts ?? current?.subagentCosts)
      ? { subagentCosts: next.subagentCosts ?? current?.subagentCosts }
      : {}),
  };
}
