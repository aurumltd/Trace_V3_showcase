/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Trace "Macaron Editorial" Design System v3
        // Figma reference: Coral Pink + Pastel Macaron palette
        aether: {
          // Base backgrounds — warm parchment cream
          100: '#FDFBF7',
          200: '#FFFFFF',
          300: '#F5F1EA',
          dark: {
            100: '#1A1718',
            200: '#242022',
            300: '#383436',
          },
          // Text colors — warm charcoal
          text: {
            primary: '#3A3638',
            secondary: '#5C5658',
            muted: '#9E9899',
            dark: {
              primary: '#F5F0ED',
              secondary: '#D4CCCF',
              muted: '#A89DA0',
            },
          },
          // Brand accent — Coral Pink
          accent: '#FF8C82',
          accentHover: '#FB5F51',
          accentSoft: 'rgba(255, 140, 130, 0.12)',
          accentDark: '#FF9E96',
          accentSoftDark: 'rgba(255, 158, 150, 0.18)',
          // Macaron palette — secondary accents
          mint: '#A8E6CF',
          lilac: '#D4C4FB',
          lemon: '#FFD3B6',
          blue: '#79BEEB',
          // Semantic colors
          success: '#A8E6CF',
          successStrong: '#4CAF50',
          successDark: '#7DCFAB',
          warning: '#FFD3B6',
          warningStrong: '#F59E0B',
          warningDark: '#FFB88C',
          // Category semantic colors
          category: {
            focus: '#A8E6CF',
            meeting: '#79BEEB',
            break: '#FFD3B6',
            creative: '#D4C4FB',
            other: '#9E9899',
          },
          // Border
          border: '#D6D3CD',
          borderCard: '#D6D3CD',
        },
        // CSS variable-driven tokens for dynamic theme switching
        primary: 'var(--color-accent)',
        accent: 'var(--color-accent)',
        accentSoft: 'var(--color-accent-soft)',
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'Noto Sans SC', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        heading: ['Quicksand', 'Noto Sans SC', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        // "Aether Prodigy" - Extra large rounded corners like modern SaaS design
        container: '24px',
        card: '20px',
        modal: '28px',
        button: '12px',
      },
      boxShadow: {
        // Editorial offset shadows (Figma: 4px 4px 0px)
        'subtle': '0 2px 16px rgba(58, 54, 56, 0.04)',
        'elevated': '0 4px 24px rgba(58, 54, 56, 0.06)',
        'container': '0 4px 28px rgba(58, 54, 56, 0.05)',
        'card': '4px 4px 0px #D6D3CD',
        'card-hover': '6px 6px 0px #D6D3CD',
        'card-accent': '4px 4px 0px rgba(255, 140, 130, 0.35)',
        'focus-ring': '0 0 0 3px rgba(255, 140, 130, 0.20)',
        'subtle-dark': '0 2px 16px rgba(0, 0, 0, 0.35)',
        'elevated-dark': '0 4px 24px rgba(0, 0, 0, 0.45)',
        'container-dark': '0 4px 28px rgba(0, 0, 0, 0.4)',
        'card-dark': '4px 4px 0px rgba(0, 0, 0, 0.30)',
      },
      spacing: {
        // 8px grid system consistent spacing
        '1': '4px',
        '2': '8px',
        '3': '12px',
        '4': '16px',
        '6': '24px',
        '8': '32px',
        '12': '48px',
        '16': '64px',
      },
      animation: {
        'breath': 'breath 4s ease-in-out infinite',
      },
      keyframes: {
        breath: {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.02)' },
        },
      },
    },
  },
  darkMode: 'class',
  plugins: [],
}
