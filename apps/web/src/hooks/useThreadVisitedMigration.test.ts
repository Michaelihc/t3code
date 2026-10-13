import { describe, expect, it } from "vite-plus/test";

import { localVisitToMigrate } from "./useThreadVisitedMigration";

describe("localVisitToMigrate", () => {
  const localVisit = "2026-07-30T10:00:00.000Z";

  it("seeds an unset server watermark from a valid local visit", () => {
    expect(localVisitToMigrate(null, localVisit)).toBe(localVisit);
    expect(localVisitToMigrate(null, undefined)).toBeUndefined();
    expect(localVisitToMigrate(null, "invalid")).toBeUndefined();
  });

  it("preserves deliberate unread state when a client with a newer local visit reloads", () => {
    expect(localVisitToMigrate("2026-07-30T09:59:59.999Z", localVisit)).toBeUndefined();
  });

  it("does not overwrite existing visits or send visits to older servers", () => {
    expect(localVisitToMigrate(localVisit, localVisit)).toBeUndefined();
    expect(localVisitToMigrate("2026-07-30T11:00:00.000Z", localVisit)).toBeUndefined();
    expect(localVisitToMigrate(undefined, localVisit)).toBeUndefined();
  });
});
