interface AuthHeaderProps {
  title: string;
  subtitle: string;
}

export function AuthHeader({ title, subtitle }: AuthHeaderProps): React.JSX.Element {
  return (
    <div>
      <h2 className="text-foreground text-2xl font-semibold tracking-tight">{title}</h2>
      <p className="text-muted-foreground mt-1.5 text-sm">{subtitle}</p>
    </div>
  );
}
