/**
 * calibrate.test.ts — #297's machine-verifiable half.
 *
 * The corpus run itself is the operator step (runbook in calibrate.ts):
 * sampling against the production DB, VTracer sweeps, and the HUMAN pass
 * over the CSV. What a test can hold still: the sampling plan is
 * deterministic and floor-inclusive, the CSV round-trips, the derivation
 * maximizes agreement with stricter tie-breaks, thresholds live in CONFIG
 * and the gate reads them at use time — and the shipped thresholds
 * reproduce the held-out labelled fixtures at the STATED agreement rate.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  agreement,
  deriveThresholds,
  flatArtFraction,
  parseLabelledCsv,
  samplePlan,
  toCsv,
  verdictFor,
  type CalibrationRow,
} from "./calibrate";
import { FALLBACK_THRESHOLDS, activeThresholds } from "./gate";

const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "calibration.fixtures.json"), "utf8"),
) as { statedAgreementRate: number; rows: CalibrationRow[] };

describe("the sampling plan", () => {
  it("always includes every floor case, spreads the rest, and is deterministic", () => {
    const corpus = Array.from({ length: 500 }, (_, i) => ({
      artifactId: i + 1,
      widthPx: i % 37 === 0 ? 64 : 200 + i * 3,
      heightPx: i % 37 === 0 ? 64 : 200 + i * 3,
    }));
    const floorIds = corpus.filter((c) => c.widthPx < 65).map((c) => c.artifactId);
    const plan = samplePlan(corpus, 100);
    for (const id of floorIds) expect(plan).toContain(id);
    expect(plan.length).toBeGreaterThanOrEqual(95);
    expect(plan.length).toBeLessThanOrEqual(100 + floorIds.length);
    expect(samplePlan(corpus, 100)).toEqual(plan); // no randomness anywhere
  });
});

describe("the CSV", () => {
  it("round-trips, and refuses bad labels and foreign headers", () => {
    const rows = FIXTURES.rows.slice(0, 3).map((r) => ({ ...r, label: "" as const }));
    const csv = toCsv(rows);
    const back = parseLabelledCsv(csv);
    expect(back).toHaveLength(3);
    expect(back[0]!.artifactId).toBe(rows[0]!.artifactId);
    expect(back[0]!.ssim).toBeCloseTo(rows[0]!.ssim!, 10);
    expect(() => parseLabelledCsv("a,b,c\n1,2,3")).toThrow(/header mismatch/);
    expect(() => parseLabelledCsv(csv.replace(/\n$/, "") + "\n1,flat,10,10,1,,,,,,maybe")).toThrow(/bad label/);
  });
});

describe("thresholds live in config, not code (#297)", () => {
  it("the committed config file is what the gate actually reads", () => {
    const committed = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "..", "..", "..", "..", "..", "config", "print-fitness-thresholds.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const active = activeThresholds();
    expect(active.ssimPass).toBe(committed["ssimPass"]);
    expect(active.deltaEReview).toBe(committed["deltaEReview"]);
    // The committed numbers are still the research pass's guesses, and the
    // file SAYS so — flipping calibrated to true is the labelled run's job.
    expect(committed["calibrated"]).toBe(false);
    expect(String(committed["provenance"])).toMatch(/UNCALIBRATED/);
  });

  it("an explicit KAX_PRINT_FITNESS_THRESHOLDS path overrides, read per call", () => {
    const tmp = path.join(__dirname, "tmp-thresholds.json");
    fs.writeFileSync(tmp, JSON.stringify({ ...FALLBACK_THRESHOLDS, ssimPass: 0.5, calibrated: true }));
    process.env["KAX_PRINT_FITNESS_THRESHOLDS"] = tmp;
    try {
      expect(activeThresholds().ssimPass).toBe(0.5);
      expect(activeThresholds().calibrated).toBe(true);
    } finally {
      delete process.env["KAX_PRINT_FITNESS_THRESHOLDS"];
      fs.unlinkSync(tmp);
    }
    expect(activeThresholds().ssimPass).toBe(0.93); // back to the committed file
  });
});

describe("the held-out fixtures hold the shipped thresholds to the stated rate", () => {
  it("agreement(shipped, fixtures) >= statedAgreementRate", () => {
    const rate = agreement(FIXTURES.rows, activeThresholds());
    expect(FIXTURES.statedAgreementRate).toBe(1.0); // stated, in the fixture file
    expect(rate).toBeGreaterThanOrEqual(FIXTURES.statedAgreementRate);
  });

  it("the floor rows fail regardless of how good their metrics look", () => {
    const floorRow = FIXTURES.rows.find((r) => r.widthPx === 64 && r.ssim === 0.99)!;
    expect(verdictFor(floorRow, activeThresholds())).toBe("fail");
  });
});

describe("threshold derivation from a labelled run", () => {
  it("maximizes agreement, marks the result calibrated, and stays coherent", () => {
    const derived = deriveThresholds(FIXTURES.rows);
    expect(derived.calibrated).toBe(true);
    expect(agreement(FIXTURES.rows, derived)).toBe(1);
    expect(derived.ssimReview).toBeLessThanOrEqual(derived.ssimPass);
    expect(derived.deltaEReview).toBeGreaterThanOrEqual(derived.deltaEPass);
    // Ties broke stricter: the pass floor sits at the weakest true pass.
    expect(derived.ssimPass).toBeCloseTo(0.94, 10);
  });

  it("refuses to derive from an unlabelled or tiny run", () => {
    const unlabelled = FIXTURES.rows.map((r) => ({ ...r, label: "" as const }));
    expect(() => deriveThresholds(unlabelled)).toThrow(/label the CSV first/);
  });
});

describe("the headline number", () => {
  it("flatArtFraction states the corpus's flat-art share", () => {
    // 10 artifacts; bands ≤ 32 on ids 1,2,3,4,5,8,9 → 7/10.
    expect(flatArtFraction(FIXTURES.rows)).toBeCloseTo(0.7, 10);
  });
});
