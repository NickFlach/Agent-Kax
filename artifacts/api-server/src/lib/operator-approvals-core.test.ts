/**
 * operator-approvals-core.test.ts — the handler registry and decision
 * validation, the parts a new approval kind wires into. The db-backed
 * request/decide flow (idempotency, the pending→decided CAS) is covered by
 * the integration suite against a live PG; here we pin the pure contract.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  _clearApprovalHandlers,
  getApprovalHandler,
  isValidDecision,
  registerApprovalHandler,
} from "./operator-approvals-core";

describe("decision validation", () => {
  it("accepts only the two decisions", () => {
    expect(isValidDecision("approved")).toBe(true);
    expect(isValidDecision("rejected")).toBe(true);
    expect(isValidDecision("pending")).toBe(false);
    expect(isValidDecision("maybe")).toBe(false);
    expect(isValidDecision(null)).toBe(false);
    expect(isValidDecision(undefined)).toBe(false);
  });
});

describe("handler registry", () => {
  beforeEach(() => _clearApprovalHandlers());

  it("returns the registered handler for a kind, undefined otherwise", () => {
    const h = { onApprove: async () => {} };
    registerApprovalHandler("tower_tenancy", h);
    expect(getApprovalHandler("tower_tenancy")).toBe(h);
    expect(getApprovalHandler("radio_ad")).toBeUndefined();
  });

  it("last registration for a kind wins (a feature owns its kind)", () => {
    const a = { onApprove: async () => {} };
    const b = { onApprove: async () => {} };
    registerApprovalHandler("radio_ad", a);
    registerApprovalHandler("radio_ad", b);
    expect(getApprovalHandler("radio_ad")).toBe(b);
  });

  it("a kind may register only onReject (e.g. refund on rejection)", () => {
    const h = { onReject: async () => {} };
    registerApprovalHandler("radio_ad", h);
    const got = getApprovalHandler("radio_ad");
    expect(got?.onApprove).toBeUndefined();
    expect(typeof got?.onReject).toBe("function");
  });
});
