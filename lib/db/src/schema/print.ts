import { pgTable, bigserial, integer, real, timestamp, varchar, index } from "drizzle-orm/pg-core";
import { artifactsTable } from "./artifacts";

/**
 * print_fitness_reports — the candidacy gate's report rows (#296),
 * REPORT-ONLY by design: nothing reads verdict to gate anything until the
 * calibration run (#297) turns the guessed thresholds into real ones.
 * verdict/reason are varchar, never pgEnum.
 */
export const printFitnessReportsTable = pgTable(
  "print_fitness_reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    artifactId: integer("artifact_id")
      .notNull()
      .references(() => artifactsTable.id, { onDelete: "cascade" }),
    /** vtracer preset; NULL when the tool did not run. */
    preset: varchar("preset", { length: 24 }),
    ssim: real("ssim"),
    meanDeltaE2000: real("mean_delta_e2000"),
    pathCount: integer("path_count"),
    nodeCount: integer("node_count"),
    svgBytes: integer("svg_bytes"),
    colorBandCount: integer("color_band_count").notNull(),
    /** pass | needs_review | fail */
    verdict: varchar("verdict", { length: 16 }).notNull(),
    /** Machine-readable, stable: source_below_floor | vectorizer_unavailable | … */
    reason: varchar("reason", { length: 64 }),
    pipelineVersion: varchar("pipeline_version", { length: 24 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("print_fitness_reports_artifact_idx").on(t.artifactId, t.createdAt.desc())],
);

export type PrintFitnessReport = typeof printFitnessReportsTable.$inferSelect;
