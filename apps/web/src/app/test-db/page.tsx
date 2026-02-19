import { db } from '@balo/db';
import { users, verticals } from '@balo/db/schema';

export const dynamic = 'force-dynamic';

export default async function TestDbPage() {
  const userCount = await db.select().from(users);
  const verticalList = await db.select().from(verticals);

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold">Database Connection Test</h1>
      <div className="mt-4 space-y-4">
        <div>
          <h2 className="font-semibold">Users</h2>
          <p className="text-muted-foreground">Count: {userCount.length}</p>
        </div>
        <div>
          <h2 className="font-semibold">Verticals</h2>
          <ul>
            {verticalList.map((v) => (
              <li key={v.id}>
                {v.name} ({v.isActive ? 'active' : 'inactive'})
              </li>
            ))}
          </ul>
        </div>
      </div>
    </main>
  );
}
