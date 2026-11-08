import './globals.css'

export const metadata = {
  title: 'Anvil · Work orchestration',
  description: 'Campaigns, Commission contracts, and development sessions.',
}

export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>
}
