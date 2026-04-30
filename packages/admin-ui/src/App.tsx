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
          // When a token is set, defer to WalletAuth's signed-in display
          // (it shows the connected wallet + a Sign out button that also
          // disconnects wagmi). For a Google-issued token there's no wagmi
          // session to disconnect, so the same Sign out button is fine —
          // it just clears the auth token. We additionally show a plain
          // Sign out button here so Google-only sessions have an exit
          // path even when no wallet is connected.
          <div className="flex items-center gap-3">
            <WalletAuth />
            <button
              onClick={() => setToken(null)}
              className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Sign out
            </button>
          </div>
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
