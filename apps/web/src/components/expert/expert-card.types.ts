export type SkillType = 'technical' | 'architecture' | 'admin' | 'strategy';

export interface ExpertiseItem {
  product: string;
  skills: SkillType[];
}

export interface ExpertCardData {
  id: string;
  name: string;
  initials: string;
  avatarKey: string | null;
  title: string;
  bio: string | null;
  location: string;
  yearsExp: number;
  certifications: number;
  consultationCount: number;
  rating: number | null;
  reviewCount: number;
  rate: number;
  available: boolean;
  expertise: ExpertiseItem[];
}

export interface ExpertCardProps {
  expert: ExpertCardData;
  orderBy?: string[];
  variant?: 'card' | 'compact';
  onBook?: () => void;
  onViewProfile?: () => void;
}
