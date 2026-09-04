const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
  usage: "sort"
});

export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function naturalPathCompare(left: string, right: string): number {
  return naturalCollator.compare(fileNameFromPath(left), fileNameFromPath(right))
    || naturalCollator.compare(left, right);
}

export function naturalSortPaths(paths: string[]): string[] {
  return paths.map((path, index) => ({ path, index }))
    .sort((left, right) => naturalPathCompare(left.path, right.path) || left.index - right.index)
    .map(({ path }) => path);
}
