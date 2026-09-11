import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/utils';
import { track, ADMIN_LOOKUP_EVENTS } from '@/lib/analytics';
import { LookupAnalytics } from './lookup-analytics';

const trackMock = vi.mocked(track);

beforeEach(() => {
  trackMock.mockClear();
});

describe('LookupAnalytics', () => {
  it('fires SEARCHED once for a settled (query, filter) pair, with the classified matched_by', () => {
    render(
      <LookupAnalytics
        query="dana@northwind.com.au"
        typeFilter="all"
        resultCount={3}
        opened={null}
        tabSelected={null}
      />
    );
    expect(trackMock).toHaveBeenCalledWith(ADMIN_LOOKUP_EVENTS.SEARCHED, {
      result_count: 3,
      type_filter: 'all',
      matched_by: 'email',
    });
  });

  it('does not fire SEARCHED for an empty query', () => {
    render(
      <LookupAnalytics query="" typeFilter="all" resultCount={0} opened={null} tabSelected={null} />
    );
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('does not re-fire SEARCHED on an unchanged (query, filter) pair', () => {
    const { rerender } = render(
      <LookupAnalytics
        query="dana"
        typeFilter="all"
        resultCount={3}
        opened={null}
        tabSelected={null}
      />
    );
    rerender(
      <LookupAnalytics
        query="dana"
        typeFilter="all"
        resultCount={3}
        opened={null}
        tabSelected={null}
      />
    );
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('re-fires SEARCHED when the filter changes for the same query', () => {
    const { rerender } = render(
      <LookupAnalytics
        query="dana"
        typeFilter="all"
        resultCount={3}
        opened={null}
        tabSelected={null}
      />
    );
    rerender(
      <LookupAnalytics
        query="dana"
        typeFilter="people"
        resultCount={2}
        opened={null}
        tabSelected={null}
      />
    );
    expect(trackMock).toHaveBeenCalledTimes(2);
    expect(trackMock).toHaveBeenLastCalledWith(ADMIN_LOOKUP_EVENTS.SEARCHED, {
      result_count: 2,
      type_filter: 'people',
      matched_by: 'name',
    });
  });

  it('never puts the query string itself in the payload', () => {
    render(
      <LookupAnalytics
        query="dana@northwind.com.au"
        typeFilter="all"
        resultCount={1}
        opened={null}
        tabSelected={null}
      />
    );
    const [, payload] = trackMock.mock.calls[0] ?? [];
    expect(JSON.stringify(payload)).not.toContain('dana@northwind.com.au');
  });

  it('fires OPENED once per selection seq', () => {
    const { rerender } = render(
      <LookupAnalytics
        query=""
        typeFilter="all"
        resultCount={0}
        opened={{ entityType: 'user', via: 'search', seq: 1 }}
        tabSelected={null}
      />
    );
    expect(trackMock).toHaveBeenCalledWith(ADMIN_LOOKUP_EVENTS.OPENED, {
      entity_type: 'user',
      via: 'search',
    });

    trackMock.mockClear();
    rerender(
      <LookupAnalytics
        query=""
        typeFilter="all"
        resultCount={0}
        opened={{ entityType: 'user', via: 'search', seq: 1 }}
        tabSelected={null}
      />
    );
    expect(trackMock).not.toHaveBeenCalled();

    rerender(
      <LookupAnalytics
        query=""
        typeFilter="all"
        resultCount={0}
        opened={{ entityType: 'company', via: 'recent', seq: 2 }}
        tabSelected={null}
      />
    );
    expect(trackMock).toHaveBeenCalledWith(ADMIN_LOOKUP_EVENTS.OPENED, {
      entity_type: 'company',
      via: 'recent',
    });
  });

  it('fires TAB_SELECTED once per tabSelected seq, never on the default render', () => {
    const { rerender } = render(
      <LookupAnalytics query="" typeFilter="all" resultCount={0} opened={null} tabSelected={null} />
    );
    expect(trackMock).not.toHaveBeenCalled();

    rerender(
      <LookupAnalytics
        query=""
        typeFilter="all"
        resultCount={0}
        opened={null}
        tabSelected={{ tab: 'money', entityType: 'credit_session', seq: 1 }}
      />
    );
    expect(trackMock).toHaveBeenCalledWith(ADMIN_LOOKUP_EVENTS.TAB_SELECTED, {
      entity_type: 'credit_session',
      tab: 'money',
    });

    trackMock.mockClear();
    rerender(
      <LookupAnalytics
        query=""
        typeFilter="all"
        resultCount={0}
        opened={null}
        tabSelected={{ tab: 'money', entityType: 'credit_session', seq: 1 }}
      />
    );
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('renders nothing', () => {
    const { container } = render(
      <LookupAnalytics query="" typeFilter="all" resultCount={0} opened={null} tabSelected={null} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
