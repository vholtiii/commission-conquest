import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // THE COMMISSION Game Colors
        commission: {
          burgundy: "hsl(var(--commission-burgundy))",
          gold: "hsl(var(--commission-gold))",
          dark: "hsl(var(--commission-dark))",
          "dark-elevated": "hsl(var(--commission-dark-elevated))",
          territory: "hsl(var(--commission-territory))",
          neutral: "hsl(var(--commission-neutral))",
        },
        // Commission Conquest UI palette
        panel: {
          DEFAULT: "hsl(var(--panel))",
          elevated: "hsl(var(--panel-elevated))",
          border: "hsl(var(--panel-border))",
        },
        steel: {
          DEFAULT: "hsl(var(--steel))",
          light: "hsl(var(--steel-light))",
          dark: "hsl(var(--steel-dark))",
        },
        gold: {
          DEFAULT: "hsl(var(--money-gold))",
          dim: "hsl(var(--money-gold-dim))",
        },
        heat: {
          DEFAULT: "hsl(var(--heat-red))",
          dim: "hsl(var(--heat-red-dim))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        display: ["Limelight", "serif"],
        ui: ['"Barlow Condensed"', "sans-serif"],
        sans: ['"Barlow Condensed"', "sans-serif"],
      },
      backgroundImage: {
        "gradient-hero": "var(--gradient-hero)",
        "gradient-gold": "var(--gradient-gold)",
        "gradient-card": "var(--gradient-card)",
      },
      boxShadow: {
        commission: "var(--shadow-commission)",
        gold: "var(--shadow-gold)",
        "card-elevated": "var(--shadow-card)",
      },
      transition: {
        smooth: "var(--transition-smooth)",
        bounce: "var(--transition-bounce)",
      },
      keyframes: {
        "accordion-down": {
          from: {
            height: "0",
          },
          to: {
            height: "var(--radix-accordion-content-height)",
          },
        },
        "accordion-up": {
          from: {
            height: "var(--radix-accordion-content-height)",
          },
          to: {
            height: "0",
          },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config;
