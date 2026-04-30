import { useAccount } from 'wagmi';
import { WalletAuth } from './components/wallet-auth';
import { GoogleAuth } from './components/google-auth';
import { Chat } from './components/chat';
import { useAuthToken, setToken } from './lib/auth-token';

export default function App() {
  const token = useAuthToken();
  const { isConnected } = useAccount();

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-6 py-3">
        <h1 className="text-lg font-semibold text-zinc-100">Vicoop Bridge Admin</h1>
        {token ? (
          // Both SIWE and Google sign-in produce `vbc_owner_*` tokens
          // (audience='owner_session'), so prefix doesn't tell us the
          // provider. Use the live wagmi connection instead: if a wallet
          // is connected, defer to WalletAuth's signed-in display (it
          // owns the wagmi disconnect on sign-out); otherwise show a
          // plain Sign out that just clears the auth token.
          isConnected ? (
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
