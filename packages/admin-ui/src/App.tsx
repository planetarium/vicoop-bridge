import { WalletAuth } from './components/wallet-auth';
import { GoogleAuth } from './components/google-auth';
import { Chat } from './components/chat';
import { useAuthToken, setToken } from './lib/auth-token';

export default function App() {
  const token = useAuthToken();

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-6 py-3">
        <h1 className="text-lg font-semibold text-zinc-100">Vicoop Bridge Admin</h1>
        {token ? (
          // SIWE-issued tokens use the `vbc_caller_*` prefix; anything else
          // (currently `vbc_owner_*` from Google) is a non-wallet session.
          // The wallet-auth subtree only makes sense for wallet sessions —
          // it owns the wagmi disconnect on sign-out.
          token.startsWith('vbc_caller_') ? (
            <WalletAuth />
          ) : (
            <button
              onClick={() => setToken(null)}
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
      {token ? (
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
