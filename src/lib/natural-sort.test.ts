import { describe, expect, it } from "vitest";
import { naturalFileNameCompare } from "./natural-sort";

describe("natural file-name ordering", () => {
  it("orders numbered scan pages by numeric value", () => {
    expect(["scan10.png", "scan2.png", "scan1.png"].sort(naturalFileNameCompare))
      .toEqual(["scan1.png", "scan2.png", "scan10.png"]);
  });

  it("is case insensitive for ordinary file-name sorting", () => {
    expect(["B.png", "a.png"].sort(naturalFileNameCompare)).toEqual(["a.png", "B.png"]);
  });
});
