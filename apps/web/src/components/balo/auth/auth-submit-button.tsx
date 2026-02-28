'use client';

import { Loader2 } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';

interface AuthSubmitButtonProps {
  isLoading: boolean;
  text: string;
}

export function AuthSubmitButton({ isLoading, text }: AuthSubmitButtonProps): React.JSX.Element {
  return (
    <motion.div whileTap={{ scale: 0.98 }}>
      <Button type="submit" className="h-11 w-full text-sm font-medium" disabled={isLoading}>
        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : text}
      </Button>
    </motion.div>
  );
}
