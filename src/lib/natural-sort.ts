const fileNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base"
});

export function naturalFileNameCompare(left: string, right: string): number {
  return fileNameCollator.compare(left, right);
}
