/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        success: 'rgb(var(--status-positive) / <alpha-value>)',
        danger: 'rgb(var(--status-negative) / <alpha-value>)',
        'success-solid': 'rgb(var(--status-positive-fill) / <alpha-value>)',
        yappr: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0369a1',
          600: '#075985',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
          950: '#082f49',
        },
        neutral: {
          750: '#323232',
          850: '#1a1a1a',
        }
      },
      textColor: {
        yappr: {
          400: 'rgb(var(--accent-text) / <alpha-value>)',
          500: 'rgb(var(--accent-text) / <alpha-value>)',
          600: 'rgb(var(--accent-text-hover) / <alpha-value>)',
        },
        gray: {
          400: 'rgb(var(--text-muted) / <alpha-value>)',
          500: 'rgb(var(--text-secondary) / <alpha-value>)',
        },
      },
      outlineColor: {
        yappr: {
          600: 'rgb(var(--accent-text-hover) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      animation: {
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        'pulse-soft': 'pulseSoft 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideDown: {
          '0%': { transform: 'translateY(-10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        }
      },
      backgroundImage: {
        'gradient-yappr': 'linear-gradient(135deg, #0369a1 0%, #075985 100%)',
        'gradient-dark': 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
      },
      boxShadow: {
        'yappr': '0 4px 20px -4px rgba(14, 165, 233, 0.5)',
        'yappr-lg': '0 10px 40px -10px rgba(14, 165, 233, 0.4)',
      }
    },
  },
  plugins: [],
}