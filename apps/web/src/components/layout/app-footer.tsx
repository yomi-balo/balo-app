'use client';

import { useEffect } from 'react';
import { getVersionString, APP_VERSION } from '@/lib/version';

export function AppFooter() {
  useEffect(() => {
    console.log(
      `%c Balo ${getVersionString()} `,
      'background: #111; color: #fff; padding: 2px 6px; border-radius: 3px;'
    );
  }, []);

  return (
    <footer className="text-muted-foreground py-4 text-center text-xs">
      <span title={`Branch: ${APP_VERSION.branch} | Built: ${APP_VERSION.buildTime}`}>
        {getVersionString()}
      </span>
    </footer>
  );
}
