import { describe, expect, it } from "vitest";
import { naturalSortPaths } from "./file-order";

describe("natural file order", () => {
  it("orders numeric page names as people expect", () => {
    expect(naturalSortPaths([
      "C:/scan/第10页.png", "C:/scan/第2页.png", "C:/scan/第1页.png", "C:/scan/第02页.png"
    ])).toEqual([
      "C:/scan/第1页.png", "C:/scan/第2页.png", "C:/scan/第02页.png", "C:/scan/第10页.png"
    ]);
  });

  it("uses the full path as a deterministic tie breaker", () => {
    expect(naturalSortPaths(["/b/page1.png", "/a/page1.png"])).toEqual(["/a/page1.png", "/b/page1.png"]);
  });
});
