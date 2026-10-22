import { ClerkProvider } from "@clerk/nextjs";

// Routes that use Clerk on the client (useUser, UserButton, <SignIn>...).
// Public pages sit outside this group so they don't download Clerk.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      appearance={{
        // Clerk renders in our paper-and-ink: ink primary button (orange is
        // never a button fill), hairline card, 6px radii, Geist.
        variables: {
          colorPrimary: "#0A0A0A",
          colorPrimaryForeground: "#FAFAF7",
          colorForeground: "#0A0A0A",
          colorMutedForeground: "#6B6B66",
          colorBackground: "#FFFFFF",
          colorInput: "#FFFFFF",
          colorInputForeground: "#0A0A0A",
          colorBorder: "#D8D7D0",
          colorRing: "oklch(0.96 0.04 70)",
          borderRadius: "6px",
          fontFamily: "var(--font-geist-sans), Geist, sans-serif",
          fontSize: "14px",
        },
        elements: {
          rootBox: { width: "100%" },
          cardBox: { width: "100%", boxShadow: "none", border: "1px solid var(--line)", borderRadius: "var(--r)" },
          card: { boxShadow: "none" },
          formButtonPrimary: { boxShadow: "none", fontWeight: 500, minHeight: "40px" },
          socialButtonsBlockButton: { minHeight: "40px", borderColor: "var(--line-strong)" },
          formFieldInput: { minHeight: "40px" },
          footerActionLink: { color: "var(--text)", fontWeight: 500, textDecoration: "underline", textUnderlineOffset: "2px" },
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
