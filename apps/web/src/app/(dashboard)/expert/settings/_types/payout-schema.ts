export interface NormalizedField {
  path: string;
  required: boolean;
  label: string;
  description?: string;
  placeholder?: string;
  tip?: string;
  type: 'text' | 'enum';
  options?: Array<{ label: string; value: string }>;
  defaultValue?: string;
  refresh: boolean;
  validation?: { pattern: string };
  wide?: boolean;
}
