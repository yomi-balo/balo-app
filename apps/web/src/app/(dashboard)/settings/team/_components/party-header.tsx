import { Building2, ShieldCheck } from 'lucide-react';

/**
 * Page header for the company "Members & access" surface (BAL-347): party context +
 * the "Admin · Manage members" capability chip. Presentational — the page is already
 * hard-gated on `MANAGE_MEMBERS`, so this chip is an affordance, not the gate.
 */
export function PartyHeader({ companyName }: Readonly<{ companyName: string }>): React.JSX.Element {
  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="from-primary flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br to-purple-600 text-white"
          >
            <Building2 className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-foreground text-2xl font-semibold tracking-tight">
              Members &amp; access
            </h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {companyName} · Company workspace
            </p>
          </div>
        </div>
        <span className="bg-primary/10 text-primary border-primary/20 inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Admin · Manage members
        </span>
      </div>
      <p className="text-muted-foreground mt-2.5 text-xs">
        Only owners and admins with the Manage members permission can see this page.
      </p>
    </div>
  );
}
