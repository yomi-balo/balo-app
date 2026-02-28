interface AuthDividerProps {
  text?: string;
}

export function AuthDivider({
  text = 'or continue with email',
}: AuthDividerProps): React.JSX.Element {
  return (
    <div className="relative my-6">
      <div className="absolute inset-0 flex items-center">
        <div className="border-border w-full border-t" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-background text-muted-foreground px-3 text-xs tracking-wider uppercase">
          {text}
        </span>
      </div>
    </div>
  );
}
