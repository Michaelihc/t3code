import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionThreadBranchPullRequest from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import ProjectionThreadsActiveOrderKey from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import ProjectionThreadPullRequests from "./Migrations/050_ProjectionThreadPullRequests.ts";
import ProjectionThreadMessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import ProjectionThreadTitleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";

export const reconcilePreviewMigrations = Effect.fn("reconcilePreviewMigrations")(function* (
  manifest: ReadonlyArray<readonly [number, string]>,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      const preview = yield* sql`
        SELECT 1 FROM effect_sql_migrations
        WHERE migration_id = 60 AND name = 'ReconcileRenumberedOv2Schema'
          AND EXISTS (
            SELECT 1 FROM effect_sql_migrations
            WHERE migration_id = 59 AND name = 'OrchestrationV2ShellIndexes'
          )
          AND EXISTS (
            SELECT 1 FROM effect_sql_migrations
            WHERE migration_id < 50 AND name = 'OrchestrationV2'
          )
      `;
      const consolidated = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations
        WHERE name = 'OrchestrationV2' AND migration_id BETWEEN 50 AND 52
      `;
      if (preview.length === 0 && consolidated.length === 0) return;

      // This fork's preview migration 60 completed the V2 schema and released
      // migrations through 47. V2 was subsequently consolidated and renumbered
      // as main added migrations. Fill missing legacy schema without replaying
      // V2's event import, retaining each old ledger for recovery.
      yield* ProjectionThreadBranchPullRequest;
      yield* ProjectionThreadsActiveOrderKey;
      yield* ProjectionThreadPullRequests;
      yield* ProjectionThreadMessageContext;
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      if (!columns.some(({ name }) => name === "title_state_json")) {
        yield* ProjectionThreadTitleState;
      }
      yield* PullRequestFilesViewed;
      const archive = consolidated[0]
        ? `effect_sql_migrations_ov2_preview_${consolidated[0].migration_id}`
        : "effect_sql_migrations_ov2_preview";
      yield* sql`
        ALTER TABLE effect_sql_migrations RENAME TO ${sql(archive)}
      `;
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            manifest.filter(([id]) => id <= 54).map(([id, name]) => [`${id}_${name}`, Effect.void]),
          ),
        ),
      });
      yield* Effect.log("Reconciled completed OV2 preview migrations with the released schema");
    }),
  );
});
