interface AuthFooterLinkProps {
  text: string;
  linkText: string;
  onClick: () => void;
}

export function AuthFooterLink({
  text,
  linkText,
  onClick,
}: AuthFooterLinkProps): React.JSX.Element {
  return (
    <p className="text-muted-foreground mt-6 text-center text-sm">
      {text}{' '}
      <button
        type="button"
        onClick={onClick}
        className="text-primary hover:text-primary/80 focus-visible:ring-ring rounded-md font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        {linkText}
      </button>
    </p>
  );
}
