'use client';

import { useState } from 'react';

export default function TestErrorPage() {
  const [shouldThrow, setShouldThrow] = useState(false);

  if (shouldThrow) {
    throw new Error('Test Sentry error from balo-web client');
  }

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold">Sentry Error Test</h1>
      <button
        onClick={() => setShouldThrow(true)}
        className="mt-4 rounded bg-red-600 px-4 py-2 text-white hover:bg-red-700"
      >
        Trigger Test Error
      </button>
    </main>
  );
}
