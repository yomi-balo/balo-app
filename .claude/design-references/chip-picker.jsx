import { useState } from 'react';

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap');
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  font-family: 'DM Sans', -apple-system, sans-serif;
  background: #F0F2F7;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
}

.card {
  background: white;
  border-radius: 16px;
  border: 1px solid #E0E4EB;
  padding: 22px 24px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  max-width: 640px;
  width: 100%;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 16px;
}

.card-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #0891B2;
  margin: 0;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 12px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  font-family: 'DM Sans', -apple-system, sans-serif;
  cursor: pointer;
  border: 1.5px solid;
  transition: all 0.15s ease;
  user-select: none;
  white-space: nowrap;
  background: none;
}

.chip:active { transform: scale(0.97); }

/* Unselected */
.chip-off {
  border-color: #D1D5DB;
  background: white;
  color: #6B7280;
}
.chip-off:hover {
  border-color: #9CA3AF;
  color: #374151;
  background: #F9FAFB;
}

/* Selected */
.chip-on {
  border-color: #2563EB;
  background: #EFF6FF;
  color: #1D4ED8;
  font-weight: 600;
}
.chip-on:hover {
  background: #DBEAFE;
  border-color: #1D4ED8;
}
`;

const CheckIcon = () => (
  <svg
    width={12}
    height={12}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
  >
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

const BriefcaseIcon = () => (
  <svg
    width={13}
    height={13}
    viewBox="0 0 24 24"
    fill="none"
    stroke="#0891B2"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z" />
    <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
  </svg>
);

const INDUSTRIES = [
  'Agriculture & Mining',
  'Automotive',
  'Communications',
  'Consumer Goods',
  'Education',
  'Energy & Utilities',
  'Engineering',
  'Financial Services',
  'Healthcare & Life Sciences',
  'Manufacturing',
  'Media & Entertainment',
  'Non-profit',
  'Professional Services',
  'Public Sector & Government',
  'Real Estate & Construction',
  'Retail',
  'Technology',
  'Transportation',
  'Travel & Hospitality',
];

export default function IndustryChipPicker() {
  const [selected, setSelected] = useState(new Set(['Financial Services', 'Technology']));

  const toggle = (ind) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(ind) ? next.delete(ind) : next.add(ind);
      return next;
    });
  };

  return (
    <>
      <style>{CSS}</style>
      <div className="card">
        <div className="card-header">
          <BriefcaseIcon />
          <p className="card-title">Industries</p>
        </div>
        <div className="chips">
          {INDUSTRIES.map((ind) => {
            const on = selected.has(ind);
            return (
              <button
                key={ind}
                className={`chip ${on ? 'chip-on' : 'chip-off'}`}
                onClick={() => toggle(ind)}
              >
                {on && <CheckIcon />}
                {ind}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
