import { ClerkProvider } from "@clerk/nextjs";

// Routes that use Clerk on the client (useUser, UserButton, <SignIn>...).
// Public pages sit outside this group so they don't download Clerk.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          // Match the brand: amber accent (--accent) and Geist type.
          colorPrimary: "oklch(0.72 0.18 55)",
          fontFamily: "var(--font-geist-sans), Geist, sans-serif",
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
