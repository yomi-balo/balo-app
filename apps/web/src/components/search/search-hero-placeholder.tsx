'use client';

// PLACEHOLDER — replaced by the search composer ticket. Do not invest in styling.
// Owns only the free-text `q` param: a single search input + button that writes
// `q` to the URL on submit.

import { useCallback, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { useUpdateSearchParams } from './use-update-search-params';

interface SearchHeroPlaceholderProps {
  /** Initial query from the URL. */
  initialQuery: string;
}

export function SearchHeroPlaceholder({
  initialQuery,
}: Readonly<SearchHeroPlaceholderProps>): React.JSX.Element {
  const { setParam } = useUpdateSearchParams();
  const [value, setValue] = useState(initialQuery);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      setParam('q', value.trim() === '' ? null : value.trim());
    },
    [value, setParam]
  );

  return (
    <div className="from-primary/5 border-primary/10 mb-7 rounded-2xl border bg-gradient-to-br to-violet-500/5 p-6 md:p-7">
      <h1 className="text-foreground text-[22px] font-semibold md:text-[26px]">
        Find a Salesforce expert
      </h1>
      <p className="text-muted-foreground mt-1.5 text-sm">
        Describe what you need help with &mdash; we&apos;ll match you with vetted consultants who
        can jump on a call.
      </p>
      <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-2.5 md:flex-row">
        <div className="border-border bg-card focus-within:border-ring focus-within:ring-ring/30 flex h-[52px] flex-1 items-center gap-2.5 rounded-xl border px-4 transition-shadow focus-within:ring-[3px]">
          <Search className="text-muted-foreground h-[18px] w-[18px] shrink-0" />
          <label htmlFor="hero-search" className="sr-only">
            Search experts
          </label>
          <input
            id="hero-search"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. Agentforce rollout for a mid-market support team"
            className="text-foreground placeholder:text-muted-foreground h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none"
          />
        </div>
        <button
          type="submit"
          className="from-primary focus-visible:ring-ring flex h-[52px] items-center justify-center rounded-xl bg-gradient-to-r to-violet-600 px-7 text-[15px] font-semibold text-white shadow-sm transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:outline-none dark:to-violet-500"
        >
          Search
        </button>
      </form>
    </div>
  );
}
