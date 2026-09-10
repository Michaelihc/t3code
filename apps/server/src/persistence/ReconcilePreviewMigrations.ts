import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionThreadBranchPullRequest from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import ProjectionThreadsActiveOrderKey from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";

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
      if (preview.length === 0) return;

      // This fork's preview migration 60 completed the V2 schema and released
      // migrations through 47. Upstream subsequently folded V2 into migration
      // 50. Fill the two remaining columns without replaying V2's event import,
      // and retain the old ledger before adopting the released numbering so
      // future migrations 51 onward are not silently skipped.
      yield* ProjectionThreadBranchPullRequest;
      yield* ProjectionThreadsActiveOrderKey;
      yield* sql`
        ALTER TABLE effect_sql_migrations RENAME TO effect_sql_migrations_ov2_preview
      `;
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            manifest.filter(([id]) => id <= 50).map(([id, name]) => [`${id}_${name}`, Effect.void]),
          ),
        ),
      });
      yield* Effect.log("Reconciled completed OV2 preview migrations with the released schema");
    }),
  );
});
