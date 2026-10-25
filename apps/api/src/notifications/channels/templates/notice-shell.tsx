import { Button, Heading, Section, Text } from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';
import { shared, EmailShell, LogoRow, StatusPill } from './shared.js';

export const successPill: CSSProperties = {
  ...shared.statusPillBase,
  background: 'rgba(5, 150, 105, 0.16)',
  border: '1px solid rgba(5, 150, 105, 0.32)',
  color: '#6EE7B7',
};

export const amberPill: CSSProperties = {
  ...shared.statusPillBase,
  background: 'rgba(217, 119, 6, 0.16)',
  border: '1px solid rgba(217, 119, 6, 0.32)',
  color: '#FCD34D',
};

export interface NoticeShellProps {
  readonly previewText: string;
  readonly pillLabel: string;
  readonly pillStyle: CSSProperties;
  readonly heading: string;
  readonly subtext?: string;
  readonly firstName: string;
  readonly baseUrl: string;
  readonly children: ReactNode;
}

/** Shared shell for the notice emails: hero (logo/pill/heading) + card (greeting + body). */
export function NoticeShell({
  previewText,
  pillLabel,
  pillStyle,
  heading,
  subtext,
  firstName,
  baseUrl,
  children,
}: NoticeShellProps) {
  return (
    <EmailShell previewText={previewText} baseUrl={baseUrl}>
      <Section style={shared.smallHero}>
        <LogoRow size="small" />
        <StatusPill label={pillLabel} style={pillStyle} />
        <Heading style={shared.smallHeroHeading}>{heading}</Heading>
        {subtext ? <Text style={shared.smallHeroSubtext}>{subtext}</Text> : null}
      </Section>
      <Section style={shared.card}>
        <Text style={shared.greeting}>Hi {firstName},</Text>
        {children}
      </Section>
    </EmailShell>
  );
}

/** A "View the project →" CTA linking to the delivery workspace. */
export function ViewProjectCta({
  engagementUrl,
  label = 'View the project →',
}: Readonly<{
  engagementUrl: string;
  label?: string;
}>) {
  return (
    <Section style={{ ...shared.ctaWrapper, margin: '24px 0 4px' }}>
      <Button style={shared.smallCtaButton} href={engagementUrl}>
        {label}
      </Button>
    </Section>
  );
}
