import { Html, Head, Body, Container, Heading, Text, Button, Hr } from '@react-email/components';

interface WelcomeEmailProps {
  recipientName: string;
  baseUrl: string;
}

export function WelcomeEmail({ recipientName, baseUrl }: WelcomeEmailProps) {
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
            Welcome to Balo
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
            Your account is ready. Connect with expert Salesforce consultants for real-time advice,
            project work, or packaged solutions.
          </Text>
          <Button
            href={`${baseUrl}/dashboard`}
            style={{
              background: '#2563EB',
              color: '#fff',
              padding: '12px 24px',
              borderRadius: 8,
              fontSize: 16,
              fontWeight: 500,
              marginTop: 16,
            }}
          >
            Go to Dashboard
          </Button>
          <Hr style={{ borderColor: '#e2e8f0', margin: '32px 0' }} />
          <Text style={{ fontSize: 13, color: '#94a3b8' }}>
            Balo — Expert consultants on demand
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
