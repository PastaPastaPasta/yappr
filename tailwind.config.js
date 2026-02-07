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
          50: '#FEF4F2',
          100: '#FDE7E2',
          200: '#FDD3CA',
          300: '#FAB3A5',
          400: '#F58872',
          500: '#EC6147',
          600: '#D94B30',
          700: '#B63C23',
          800: '#963321',
          900: '#7D2E21',
          950: '#44150D',
        },
        accent: {
          teal: '#14B8A6',
          'teal-light': '#5EEAD4',
          'teal-dark': '#0D9488',
        },
        surface: {
          50: '#FDFCFA',
          100: '#F7F6F3',
          200: '#EDECE7',
          300: '#DFDDD6',
          800: '#1A2035',
          850: '#141B2D',
          900: '#0F1625',
          950: '#0A0F1A',
        },
        neutral: {
          750: '#2D3548',
          850: '#1A2035',
        }
      },
      fontFamily: {
        display: ['Georgia', '"Palatino Linotype"', '"Book Antiqua"', 'Palatino', 'serif'],
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"SF Mono"', '"Cascadia Code"', '"Fira Code"', 'Menlo', 'Consolas', 'monospace'],
      },
      animation: {
        'slide-up': 'slideUp 0.3s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        'pulse-soft': 'pulseSoft 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'gradient-shift': 'gradientShift 8s ease infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
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
        },
        gradientShift: {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        glow: {
          '0%': { boxShadow: '0 0 20px rgba(236, 97, 71, 0.15)' },
          '100%': { boxShadow: '0 0 30px rgba(236, 97, 71, 0.3)' },
        },
      },
      backgroundImage: {
        'gradient-yappr': 'linear-gradient(135deg, #EC6147 0%, #D94B30 50%, #B63C23 100%)',
        'gradient-dark': 'linear-gradient(135deg, #1A2035 0%, #0F1625 100%)',
        'gradient-warm': 'linear-gradient(135deg, #EC6147 0%, #F58872 50%, #FAB3A5 100%)',
        'gradient-mesh-light': 'radial-gradient(ellipse at 20% 50%, rgba(236, 97, 71, 0.08) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(20, 184, 166, 0.06) 0%, transparent 50%), radial-gradient(ellipse at 40% 80%, rgba(236, 97, 71, 0.04) 0%, transparent 50%)',
        'gradient-mesh-dark': 'radial-gradient(ellipse at 20% 50%, rgba(236, 97, 71, 0.06) 0%, transparent 50%), radial-gradient(ellipse at 80% 20%, rgba(20, 184, 166, 0.04) 0%, transparent 50%), radial-gradient(ellipse at 40% 80%, rgba(236, 97, 71, 0.03) 0%, transparent 50%)',
      },
      boxShadow: {
        'yappr': '0 4px 20px -4px rgba(236, 97, 71, 0.4)',
        'yappr-lg': '0 10px 40px -10px rgba(236, 97, 71, 0.35)',
        'warm': '0 4px 24px -6px rgba(0, 0, 0, 0.1), 0 0 0 1px rgba(236, 97, 71, 0.05)',
        'warm-lg': '0 20px 60px -15px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(236, 97, 71, 0.05)',
        'inner-glow': 'inset 0 1px 0 rgba(255, 255, 255, 0.1)',
        'elevated': '0 1px 3px rgba(0, 0, 0, 0.08), 0 4px 12px rgba(0, 0, 0, 0.04)',
        'elevated-lg': '0 4px 12px rgba(0, 0, 0, 0.1), 0 12px 36px rgba(0, 0, 0, 0.06)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
    },
  },
  plugins: [],
}
