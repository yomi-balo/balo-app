'use client';

import { AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface AuthErrorBannerProps {
  error: string | null;
}

export function AuthErrorBanner({ error }: AuthErrorBannerProps): React.JSX.Element {
  return (
    <AnimatePresence>
      {error && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg px-4 py-3 text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
