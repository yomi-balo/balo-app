interface ChangeOrderPriceEffectProps {
  effect: { text: string; hint: string | null };
}

/**
 * The price or estimate effect of an order, in the viewer's own terms. The text and hint are
 * derived per lens on the server (the client sees client figures, the expert sees expert
 * figures), so this component renders them verbatim and does no arithmetic.
 */
export function ChangeOrderPriceEffect({
  effect,
}: Readonly<ChangeOrderPriceEffectProps>): React.JSX.Element {
  return (
    <div className="bg-muted/60 mt-4 rounded-xl p-3 text-sm">
      <p className="text-foreground">{effect.text}</p>
      {effect.hint !== null && <p className="text-muted-foreground mt-1">{effect.hint}</p>}
    </div>
  );
}
