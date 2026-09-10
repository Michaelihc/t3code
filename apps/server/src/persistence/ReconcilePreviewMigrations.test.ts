import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const seedPreview = Effect.fn("seedPreview")(function* (firstV2Id: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`ALTER TABLE projection_threads DROP COLUMN branch_pull_request_json`;
  yield* sql`ALTER TABLE projection_threads DROP COLUMN active_order_key`;
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${firstV2Id}`;
  const previewNames = [
    "OrchestrationV2",
    "OrchestrationV2Subagents",
    "OrchestrationV2Foundation",
    "OrchestrationV2ProviderSessionBindings",
    "OrchestrationV2ThreadLaunchWorkflows",
    "ApplicationEventSource",
    "OrchestrationV2EffectCancellation",
    "ScheduledTasks",
    "LegacyV1ImportState",
  ];
  yield* sql`INSERT INTO effect_sql_migrations ${sql.insert(
    previewNames.map((name, index) => ({ migration_id: firstV2Id + index, name })),
  )}`;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES (53, 'LegacyV1ImportState'), (54, 'ApplicationEventSequenceIndexes'),
      (55, 'OrchestrationV2RecoveryIndexes'), (56, 'ReconcileEarlyOv2Schema'),
      (59, 'OrchestrationV2ShellIndexes'), (60, 'ReconcileRenumberedOv2Schema')
  `;
  yield* sql`
    INSERT INTO orchestration_v2_events
      (event_id, thread_id, event_type, occurred_at, payload_json)
    VALUES ('event:preserved', 'thread:preserved', 'thread.created', '2026-09-01T00:00:00.000Z', '{}')
  `;
});

for (const firstV2Id of [41, 44]) {
  it.effect(
    `upgrades the completed preview starting at ${firstV2Id} without replaying events`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedPreview(firstV2Id);
        const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const events = yield* sql`SELECT * FROM orchestration_v2_events ORDER BY sequence`;
        const applicationEvents = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;

        yield* runMigrations();

        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations_ov2_preview ORDER BY migration_id`,
          ledger,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM orchestration_v2_events ORDER BY sequence`,
          events,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
          applicationEvents,
        );
        const current = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
        assert.deepStrictEqual(
          current.map(({ migration_id, name }) => [migration_id, name] as const),
          migrationManifest,
        );
        // Preparing the same columns used during startup reproduces the original failure.
        yield* sql`SELECT branch_pull_request_json, active_order_key FROM projection_threads`;
        assert.deepStrictEqual(yield* runMigrations(), []);

        const next = yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "51_FutureReleasedMigration": sql`CREATE TABLE future_migration_proof (id TEXT)`,
          }),
        });
        assert.deepStrictEqual(next, [[51, "FutureReleasedMigration"]]);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

it.effect("rolls back added columns if the original ledger cannot be archived", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedPreview(44);
    const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    yield* sql`CREATE TABLE effect_sql_migrations_ov2_preview (id TEXT)`;

    const result = yield* Effect.exit(runMigrations());
    assert.equal(result._tag, "Failure");
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      ledger,
    );
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
    assert.ok(!columns.some(({ name }) => name === "branch_pull_request_json"));
    assert.ok(!columns.some(({ name }) => name === "active_order_key"));
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
