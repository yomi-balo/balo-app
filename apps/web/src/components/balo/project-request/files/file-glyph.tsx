import { FileSpreadsheet, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FileGlyphProps {
  contentType: string;
  className?: string;
}

/** The filled icon tile that stands in for a file everywhere a request file is listed. */
export function FileGlyph({ contentType, className }: Readonly<FileGlyphProps>): React.JSX.Element {
  const isSpreadsheet = contentType.includes('spreadsheet') || contentType === 'text/csv';
  const Icon = isSpreadsheet ? FileSpreadsheet : FileText;
  return (
    <span
      className={cn(
        'bg-muted text-muted-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
        className
      )}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </span>
  );
}
