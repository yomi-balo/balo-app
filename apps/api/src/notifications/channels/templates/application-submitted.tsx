import { Html, Head, Body, Container, Heading, Text, Section, Hr } from '@react-email/components';

interface ApplicationSubmittedEmailProps {
  recipientName: string;
}

export function ApplicationSubmittedEmail({ recipientName }: ApplicationSubmittedEmailProps) {
  return (
    <Html>
      <Head />
      <Body
        style={{
          fontFamily: 'Geist, Inter, sans-serif',
          background: '#f8fafc',
        }}
      >
        <Container
          style={{
            maxWidth: 560,
            margin: '0 auto',
            padding: '40px 20px',
          }}
        >
          <Heading style={{ fontSize: 24, fontWeight: 600, color: '#0f172a' }}>
            Application received
          </Heading>
          <Text
            style={{
              fontSize: 16,
              color: '#334155',
              lineHeight: '1.6',
            }}
          >
            Hi {recipientName},
          </Text>
          <Text
            style={{
              fontSize: 16,
              color: '#334155',
              lineHeight: '1.6',
            }}
          >
            Thank you for applying to become an expert on Balo. We have received your application
            and our team will review it shortly.
          </Text>
          <Section
            style={{
              background: '#fff',
              borderRadius: 12,
              padding: 24,
              border: '1px solid #e2e8f0',
              marginTop: 16,
            }}
          >
            <Text style={{ fontSize: 14, color: '#64748b', margin: 0 }}>
              <strong>What happens next?</strong>
            </Text>
            <Text
              style={{
                fontSize: 14,
                color: '#64748b',
                lineHeight: '1.6',
              }}
            >
              Our team reviews applications within 2-3 business days. You will receive an email once
              your application has been reviewed.
            </Text>
          </Section>
          <Hr style={{ borderColor: '#e2e8f0', margin: '32px 0' }} />
          <Text style={{ fontSize: 13, color: '#94a3b8' }}>
            Balo — Expert consultants on demand
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
