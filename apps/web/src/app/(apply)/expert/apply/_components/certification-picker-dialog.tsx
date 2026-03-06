'use client';

import { useState, useMemo } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { CertificationsByCategory } from '@balo/db';

interface CertificationPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: CertificationsByCategory[];
  alreadyAdded: string[];
  onAdd: (certificationIds: string[]) => void;
}

export function CertificationPickerDialog({
  open,
  onOpenChange,
  categories,
  alreadyAdded,
  onAdd,
}: Readonly<CertificationPickerDialogProps>): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const filteredCategories = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return categories;
    return categories
      .map((cat) => ({
        ...cat,
        certifications: cat.certifications.filter((c) => c.name.toLowerCase().includes(query)),
      }))
      .filter((cat) => cat.certifications.length > 0);
  }, [categories, searchQuery]);

  const toggleCert = (id: string): void => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };

  const handleAdd = (): void => {
    onAdd(selectedIds);
    setSelectedIds([]);
    setSearchQuery('');
    onOpenChange(false);
  };

  const handleClose = (): void => {
    setSelectedIds([]);
    setSearchQuery('');
    onOpenChange(false);
  };

  const alreadyAddedSet = new Set(alreadyAdded);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add Certifications</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            placeholder="Search certifications..."
            className="pl-9"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <ScrollArea className="max-h-[400px]">
          <div className="space-y-4 pr-4">
            {filteredCategories.length === 0 && (
              <p className="text-muted-foreground py-8 text-center text-sm">
                No certifications match your search
              </p>
            )}
            {filteredCategories.map((cat) => (
              <div key={cat.category.id}>
                <p className="text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase">
                  {cat.category.name}
                </p>
                <div className="space-y-1">
                  {cat.certifications.map((cert) => {
                    const isAlreadyAdded = alreadyAddedSet.has(cert.id);
                    const isSelected = selectedIds.includes(cert.id);
                    return (
                      <label
                        key={cert.id}
                        className={cn(
                          'hover:bg-muted/50 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                          isAlreadyAdded ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                        )}
                      >
                        <Checkbox
                          checked={isSelected || isAlreadyAdded}
                          disabled={isAlreadyAdded}
                          onCheckedChange={() => !isAlreadyAdded && toggleCert(cert.id)}
                        />
                        <span className="text-foreground flex-1 text-sm">{cert.name}</span>
                        {isAlreadyAdded && (
                          <span className="text-muted-foreground text-xs">Added</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleAdd} disabled={selectedIds.length === 0}>
            Add {selectedIds.length > 0 ? `${selectedIds.length} ` : ''}
            certification{selectedIds.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
