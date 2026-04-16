import { WalletAuth } from './components/wallet-auth';
import { Chat } from './components/chat';
import { useAuthToken } from './lib/auth-token';

export default function App() {
  const token = useAuthToken();

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-6 py-3">
        <h1 className="text-lg font-semibold text-zinc-100">Vicoop Bridge Admin</h1>
        <WalletAuth />
      </header>

      {/* Chat area */}
      {token ? (
        <Chat />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-zinc-400">Connect your wallet to start managing clients.</p>
        </div>
      )}
    </div>
  );
}
