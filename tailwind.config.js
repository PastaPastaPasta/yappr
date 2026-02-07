/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        yappr: {
          50: '#eef6ff',
          100: '#d9ebff',
          200: '#bcdaff',
          300: '#8ec2ff',
          400: '#59a0ff',
          500: '#3b7cf8',
          600: '#2560ed',
          700: '#1d4dd9',
          800: '#1e40af',
          900: '#1e3a8a',
          950: '#172554',
        },
        accent: {
          50: '#fff8ed',
          100: '#ffeed4',
          200: '#ffd9a8',
          300: '#ffbd71',
          400: '#ff9538',
          500: '#fe7711',
          600: '#ef5c07',
          700: '#c64308',
          800: '#9d350f',
          900: '#7e2e10',
          950: '#441406',
        },
        surface: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          950: '#020617',
        },
        neutral: {
          750: '#323232',
          850: '#1a1a1a',
        }
      },
      fontFamily: {
        display: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      animation: {
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-down': 'slideDown 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fadeIn 0.3s ease-out',
        'scale-in': 'scaleIn 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-soft': 'pulseSoft 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'shimmer': 'shimmer 2s linear infinite',
        'glow-pulse': 'glowPulse 3s ease-in-out infinite',
        'float': 'float 6s ease-in-out infinite',
        'slide-in-right': 'slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'bounce-subtle': 'bounceSubtle 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      keyframes: {
        slideUp: {
          '0%': { transform: 'translateY(12px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideDown: {
          '0%': { transform: 'translateY(-12px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.92)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        glowPulse: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '0.8' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        slideInRight: {
          '0%': { transform: 'translateX(-8px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        bounceSubtle: {
          '0%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.15)' },
          '100%': { transform: 'scale(1)' },
        }
      },
      backgroundImage: {
        'gradient-yappr': 'linear-gradient(135deg, #3b7cf8 0%, #2560ed 50%, #1d4dd9 100%)',
        'gradient-warm': 'linear-gradient(135deg, #3b7cf8 0%, #7c3aed 100%)',
        'gradient-accent': 'linear-gradient(135deg, #ff9538 0%, #fe7711 100%)',
        'gradient-dark': 'linear-gradient(135deg, #0f172a 0%, #020617 100%)',
        'gradient-surface': 'linear-gradient(180deg, rgba(59, 124, 248, 0.03) 0%, transparent 100%)',
        'gradient-glow': 'radial-gradient(ellipse at 50% 0%, rgba(59, 124, 248, 0.15), transparent 70%)',
        'gradient-mesh': 'radial-gradient(at 40% 20%, rgba(59, 124, 248, 0.08) 0px, transparent 50%), radial-gradient(at 80% 0%, rgba(124, 58, 237, 0.06) 0px, transparent 50%), radial-gradient(at 0% 50%, rgba(255, 149, 56, 0.04) 0px, transparent 50%)',
      },
      boxShadow: {
        'yappr': '0 4px 24px -4px rgba(59, 124, 248, 0.35)',
        'yappr-lg': '0 12px 40px -8px rgba(59, 124, 248, 0.3)',
        'yappr-glow': '0 0 30px rgba(59, 124, 248, 0.2)',
        'elevated': '0 2px 8px -2px rgba(0, 0, 0, 0.08), 0 4px 16px -4px rgba(0, 0, 0, 0.06)',
        'elevated-lg': '0 4px 12px -2px rgba(0, 0, 0, 0.1), 0 8px 32px -8px rgba(0, 0, 0, 0.08)',
        'inner-glow': 'inset 0 1px 0 0 rgba(255, 255, 255, 0.05)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
      transitionTimingFunction: {
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        'smooth': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
}
