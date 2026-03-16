'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { AdminUserRow } from '../_actions/list-users';
import { DeleteUserDialog } from './delete-user-dialog';
import { ApproveExpertDialog } from './approve-expert-dialog';

interface UserTableProps {
  users: AdminUserRow[];
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getRoleBadgeVariant(role: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (role) {
    case 'super_admin':
      return 'destructive';
    case 'admin':
      return 'default';
    default:
      return 'secondary';
  }
}

function getStatusBadgeVariant(
  status: string | null
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'approved':
      return 'default';
    case 'submitted':
    case 'under_review':
      return 'outline';
    case 'rejected':
      return 'destructive';
    default:
      return 'secondary';
  }
}

export function UserTable({ users }: UserTableProps): React.JSX.Element {
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    email: string;
  } | null>(null);
  const [approveTarget, setApproveTarget] = useState<{
    expertProfileId: string;
    userId: string;
    email: string;
  } | null>(null);

  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 14,
          }}
        >
          <thead>
            <tr
              style={{
                borderBottom: '1px solid #333',
                textAlign: 'left',
              }}
            >
              <th
                style={{
                  padding: '10px 12px',
                  fontWeight: 600,
                  color: '#888',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Email
              </th>
              <th
                style={{
                  padding: '10px 12px',
                  fontWeight: 600,
                  color: '#888',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Name
              </th>
              <th
                style={{
                  padding: '10px 12px',
                  fontWeight: 600,
                  color: '#888',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Role
              </th>
              <th
                style={{
                  padding: '10px 12px',
                  fontWeight: 600,
                  color: '#888',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Mode
              </th>
              <th
                style={{
                  padding: '10px 12px',
                  fontWeight: 600,
                  color: '#888',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Onboarded
              </th>
              <th
                style={{
                  padding: '10px 12px',
                  fontWeight: 600,
                  color: '#888',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Expert
              </th>
              <th
                style={{
                  padding: '10px 12px',
                  fontWeight: 600,
                  color: '#888',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Created
              </th>
              <th
                style={{
                  padding: '10px 12px',
                  fontWeight: 600,
                  color: '#888',
                  fontSize: 12,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  style={{ padding: '40px 12px', textAlign: 'center', color: '#666' }}
                >
                  No users found.
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr
                  key={user.id}
                  style={{
                    borderBottom: '1px solid #222',
                    transition: 'background-color 0.1s',
                  }}
                >
                  <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 13 }}>
                    {user.email}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    {user.firstName || user.lastName ? (
                      `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()
                    ) : (
                      <span style={{ color: '#555' }}>--</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <Badge variant={getRoleBadgeVariant(user.platformRole)}>
                      {user.platformRole}
                    </Badge>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <Badge variant="outline">{user.activeMode}</Badge>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    {user.onboardingCompleted ? (
                      <Badge variant="default">Yes</Badge>
                    ) : (
                      <Badge variant="secondary">No</Badge>
                    )}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    {user.expertProfileCount > 0 ? (
                      <Badge variant={getStatusBadgeVariant(user.applicationStatus)}>
                        {user.applicationStatus ?? 'unknown'}
                      </Badge>
                    ) : (
                      <span style={{ color: '#555' }}>--</span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '10px 12px',
                      fontSize: 13,
                      color: '#888',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {formatDate(user.createdAt)}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {user.applicationStatus === 'submitted' && user.expertProfileId && (
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() =>
                            setApproveTarget({
                              expertProfileId: user.expertProfileId!,
                              userId: user.id,
                              email: user.email,
                            })
                          }
                        >
                          Approve
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        size="xs"
                        onClick={() => setDeleteTarget({ id: user.id, email: user.email })}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {deleteTarget && (
        <DeleteUserDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          userId={deleteTarget.id}
          userEmail={deleteTarget.email}
        />
      )}

      {approveTarget && (
        <ApproveExpertDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setApproveTarget(null);
          }}
          expertProfileId={approveTarget.expertProfileId}
          userId={approveTarget.userId}
          userEmail={approveTarget.email}
        />
      )}
    </>
  );
}
