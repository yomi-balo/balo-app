'use client';

import { useState } from 'react';
import { ChevronDown, Download, Mail, Share2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ShareModal } from './share-modal';

interface ShareMenuProps {
  requestId: string;
  relationshipId: string;
  /** The active proposal version — surfaced in the Download PDF subcopy ("v3"). */
  version: number;
}

/** The blue icon tile + two-line label shared by both menu items. */
function MenuItemBody({
  icon: Icon,
  title,
  subtitle,
}: Readonly<{ icon: LucideIcon; title: string; subtitle: string }>): React.JSX.Element {
  return (
    <span className="flex items-start gap-3">
      <span className="bg-primary/10 text-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="text-foreground block text-[13.5px] font-semibold">{title}</span>
        <span className="text-muted-foreground mt-0.5 block text-xs leading-snug">{subtitle}</span>
      </span>
    </span>
  );
}

/**
 * Share menu on the client proposal header (BAL-386, Surface 1a). A ghost
 * "Share" + chevron dropdown (Radix handles outside-click / Escape close) with two
 * items: Download PDF (the BAL-385 authorized download route) and Share with a
 * colleague (opens {@link ShareModal}). Client-lens only — mounted by the client
 * review surface, never the expert/admin views.
 */
export function ShareMenu({
  requestId,
  relationshipId,
  version,
}: Readonly<ShareMenuProps>): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const downloadHref = `/projects/${requestId}/proposal/${relationshipId}/pdf`;

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Share2 className="h-4 w-4" aria-hidden="true" />
            Share
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', menuOpen && 'rotate-180')}
              aria-hidden="true"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80 p-1.5">
          <DropdownMenuItem asChild className="p-2.5">
            <a href={downloadHref} download>
              <MenuItemBody
                icon={Download}
                title="Download PDF"
                subtitle={`The proposal as a file (v${version}) — ready to save or print.`}
              />
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem className="p-2.5" onSelect={() => setModalOpen(true)}>
            <MenuItemBody
              icon={Mail}
              title="Share with a colleague"
              subtitle="Sends the PDF and a private view link to their email."
            />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ShareModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        requestId={requestId}
        relationshipId={relationshipId}
      />
    </>
  );
}
