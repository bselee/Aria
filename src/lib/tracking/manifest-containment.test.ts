/**
 * Guard 12 — manifest containment (ingest side).
 *
 * The guard's failure modes are asymmetric, so the boundary matters more than the
 * happy path: below the threshold a real shipment MUST keep its attribution, and above
 * it a magnet manifest MUST lose every PO. A guard that unlinks a legitimate 45-package
 * drop-ship is as wrong as one that lets 678 trackings poison four POs — only the second
 * is invisible once written, which is why the default is unlink.
 *
 * The real magnet evidence this encodes: POs 125212/125213/125280 each carried a 678-number
 * carrier manifest because the attribution loop is a cartesian product.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_TRACKINGS_PER_INGEST,
  applyManifestContainment,
} from "./email-tracking-ingest";

type Upsert = { po: string | null; inferred: boolean };

const po = (n: string, inferred = false): Upsert => ({ po: n, inferred });

describe("applyManifestContainment — normal shipments keep their attribution", () => {
  it.each([0, 1, 2, 25, 49, MAX_TRACKINGS_PER_INGEST])(
    "%i trackings is not manifest-sized",
    (count) => {
      const input = [po("125420")];
      const r = applyManifestContainment(count, input);
      expect(r.refused).toBe(false);
      expect(r.refusedPOs).toEqual([]);
      expect(r.poUpserts).toEqual(input);
    },
  );

  it("returns the caller's entries untouched below the threshold (no rewriting)", () => {
    const input = [po("124833"), po("23577107-S-DropshipPO"), po(null)];
    const r = applyManifestContainment(3, input);
    expect(r.poUpserts).toBe(input);
  });
});

describe("applyManifestContainment — manifest-sized messages lose every PO", () => {
  it("one tracking over the threshold is enough to refuse", () => {
    const r = applyManifestContainment(MAX_TRACKINGS_PER_INGEST + 1, [po("125420")]);
    expect(r.refused).toBe(true);
    expect(r.poUpserts).toEqual([{ po: null, inferred: false }]);
  });

  it("drops all four POs of the real 678-number magnet", () => {
    const magnet = [po("125212"), po("125213"), po("125280"), po("670549")];
    const r = applyManifestContainment(678, magnet);
    expect(r.refused).toBe(true);
    expect(r.poUpserts).toEqual([{ po: null, inferred: false }]);
    // The dropped refs must survive in the result so the warning can name them — a silent
    // refusal is an unattributable expense in three weeks' time.
    expect(r.refusedPOs).toEqual(["125212", "125213", "125280", "670549"]);
  });

  it("refuses a low-confidence inferred PO too", () => {
    const r = applyManifestContainment(120, [po("125423", true)]);
    expect(r.refused).toBe(true);
    expect(r.poUpserts).toEqual([{ po: null, inferred: false }]);
    expect(r.refusedPOs).toEqual(["125423"]);
  });

  it("keeps suffixed dropship refs verbatim in the refusal list", () => {
    const r = applyManifestContainment(51, [po("23577107-S-DropshipPO"), po("23571127-S-DropshipPO")]);
    expect(r.refusedPOs).toEqual(["23577107-S-DropshipPO", "23571127-S-DropshipPO"]);
  });

  it("a manifest with no PO still records one unlinked entry, not zero", () => {
    const r = applyManifestContainment(300, [po(null)]);
    expect(r.refused).toBe(true);
    expect(r.refusedPOs).toEqual([]);
    expect(r.poUpserts).toEqual([{ po: null, inferred: false }]);
  });

  it("does not mutate the caller's array", () => {
    const input = [po("125212"), po("125213")];
    applyManifestContainment(678, input);
    expect(input).toEqual([po("125212"), po("125213")]);
  });
});

describe("applyManifestContainment — threshold is configurable and exclusive", () => {
  it("max=5 refuses 6 and admits 5", () => {
    expect(applyManifestContainment(6, [po("1")], 5).refused).toBe(true);
    expect(applyManifestContainment(5, [po("1")], 5).refused).toBe(false);
  });

  it("the shipped default is 50", () => {
    expect(MAX_TRACKINGS_PER_INGEST).toBe(50);
  });
});
