import { WalletAuth } from './components/wallet-auth';
import { GoogleAuth } from './components/google-auth';
import { Chat } from './components/chat';
import { useAuthSession, setSession } from './lib/auth-token';

export default function App() {
  const session = useAuthSession();

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-6 py-3">
        <h1 className="text-lg font-semibold text-zinc-100">Vicoop Bridge Admin</h1>
        {session ? (
          // Provider is recorded at sign-in time (auth-token.ts). For
          // wallet sessions, defer to WalletAuth so its Sign out also
          // disconnects wagmi; for Google sessions, just clear the
          // session.
          session.provider === 'wallet' ? (
            <WalletAuth />
          ) : (
            <button
              onClick={() => setSession(null)}
              className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-3 py-1.5 rounded transition-colors"
            >
              Sign out
            </button>
          )
        ) : (
          <div className="flex items-center gap-3">
            <WalletAuth />
            <span className="text-xs text-zinc-600">or</span>
            <GoogleAuth />
          </div>
        )}
      </header>

      {/* Chat area */}
      {session ? (
        <Chat />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-zinc-400">
            Sign in with your wallet (SIWE) or Google account to start managing your clients.
          </p>
        </div>
      )}
    </div>
  );
}
