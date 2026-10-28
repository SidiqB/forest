import { describe, expect, it } from "vitest";
import { orderFileTreeEntries, visibleFileTreeEntries } from "./fileTree";

describe("file tree entries", () => {
  it("keeps each directory's descendants directly after its parent", () => {
    const files = [
      { path: "a/file.txt", is_dir: false },
      { path: "b/file.txt", is_dir: false },
      { path: "b", is_dir: true },
      { path: "a", is_dir: true },
    ];

    expect(orderFileTreeEntries(files).map((file) => file.path)).toEqual([
      "a",
      "a/file.txt",
      "b",
      "b/file.txt",
    ]);
  });

  it("treats missing page parents as roots while keeping present descendants nested", () => {
    const files = [
      { path: "ordinary/file.txt", is_dir: false },
      { path: "missing/orphan/child.txt", is_dir: false },
      { path: "missing/lonely.txt", is_dir: false },
      { path: "missing/orphan", is_dir: true },
      { path: "ordinary", is_dir: true },
      { path: "root.txt", is_dir: false },
    ];
    const original = files.map((file) => ({ ...file }));

    expect(orderFileTreeEntries(files).map((file) => file.path)).toEqual([
      "missing/orphan",
      "missing/orphan/child.txt",
      "ordinary",
      "ordinary/file.txt",
      "missing/lonely.txt",
      "root.txt",
    ]);
    expect(files).toEqual(original);
  });

  it("filters a large tree with matching ancestors and collapsed directories", () => {
    const files = [
      { path: "records", is_dir: true },
      { path: "records/2026", is_dir: true },
      { path: "records/2026/notes.md", is_dir: false },
      { path: "other", is_dir: true },
      ...Array.from({ length: 10_000 }, (_, index) => ({
        path: `other/${index}.txt`,
        is_dir: false,
      })),
    ];
    const ordered = orderFileTreeEntries(files);

    expect(
      visibleFileTreeEntries(ordered, "notes.md", new Set()).map(
        (file) => file.path,
      ),
    ).toEqual(["records", "records/2026", "records/2026/notes.md"]);
    expect(
      visibleFileTreeEntries(
        ordered,
        "notes.md",
        new Set(["records/2026"]),
      ).map((file) => file.path),
    ).toEqual(["records", "records/2026"]);
  });

  it("keeps orphan children visible despite collapse state from another page", () => {
    const files = [
      { path: "records/one.txt", is_dir: false },
      { path: "records/two.txt", is_dir: false },
      { path: "root.txt", is_dir: false },
    ];

    expect(
      visibleFileTreeEntries(files, "", new Set(["records"])).map(
        (file) => file.path,
      ),
    ).toEqual(["records/one.txt", "records/two.txt", "root.txt"]);
    expect(
      visibleFileTreeEntries(files, "two", new Set(["records"])).map(
        (file) => file.path,
      ),
    ).toEqual(["records/two.txt"]);
  });
});
