/**
 * A numbered list of plain-text clauses. Items are React text children: never rich text or
 * HTML, so markup typed into an item shows literally.
 */
export function NumberedList({ items }: Readonly<{ items: readonly string[] }>): React.JSX.Element {
  // The same body can legitimately repeat, so the key is the body plus its occurrence count.
  const seen = new Map<string, number>();
  const keyed = items.map((item) => {
    const occurrence = (seen.get(item) ?? 0) + 1;
    seen.set(item, occurrence);
    return { key: `${item}::${occurrence}`, item };
  });
  return (
    <ol className="text-foreground marker:text-muted-foreground flex list-decimal flex-col gap-1.5 pl-5 text-[13.5px] leading-relaxed">
      {keyed.map(({ key, item }) => (
        <li key={key} className="[overflow-wrap:anywhere]">
          {item}
        </li>
      ))}
    </ol>
  );
}
