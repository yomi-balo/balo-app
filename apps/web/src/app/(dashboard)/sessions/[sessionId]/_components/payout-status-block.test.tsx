import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { PayoutStatusBlock } from './payout-status-block';

describe('PayoutStatusBlock', () => {
  it('renders NO status block at all when payoutStatus is absent', () => {
    const { container } = render(<PayoutStatusBlock payoutStatus={undefined} payout={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the recorded status WITHOUT Recorded/Reference rows when payout is null', () => {
    render(<PayoutStatusBlock payoutStatus="recorded" payout={null} />);
    expect(screen.getByText('Booked')).toBeInTheDocument();
    expect(screen.queryByText('Recorded')).not.toBeInTheDocument();
    expect(screen.queryByText('Reference')).not.toBeInTheDocument();
  });

  it('renders Recorded + Reference once the obligation is booked', () => {
    render(
      <PayoutStatusBlock
        payoutStatus="recorded"
        payout={{
          reference: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          recordedAtIso: '2026-08-12T11:00:00.000Z',
        }}
      />
    );
    expect(screen.getByText('Recorded')).toBeInTheDocument();
    expect(screen.getByText('12 Aug 2026')).toBeInTheDocument();
    expect(screen.getByText('Reference')).toBeInTheDocument();
    expect(screen.getByText('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBeInTheDocument();
  });

  it('renders every status without implying a disbursement is already in progress for `failed`', () => {
    render(<PayoutStatusBlock payoutStatus="failed" payout={null} />);
    expect(screen.getByText('Needs a look')).toBeInTheDocument();
    expect(screen.getByText(/We're on it/)).toBeInTheDocument();
  });

  it('renders the paid and disbursing states', () => {
    const { unmount } = render(<PayoutStatusBlock payoutStatus="paid" payout={null} />);
    expect(screen.getByText('Paid')).toBeInTheDocument();
    unmount();
    render(<PayoutStatusBlock payoutStatus="disbursing" payout={null} />);
    expect(screen.getByText('Disbursing')).toBeInTheDocument();
  });
});
