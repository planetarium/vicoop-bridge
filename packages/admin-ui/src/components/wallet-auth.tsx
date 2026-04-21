import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useSignMessage, useDisconnect } from 'wagmi';
import { SiweMessage } from 'siwe';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthToken, setToken } from '../lib/auth-token';
import { exchangeSiweForCallerToken } from '../lib/siwe-exchange';

export function WalletAuth() {
  const { address, isConnected, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();
  const token = useAuthToken();
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoSignInAttempted = useRef(false);

  const signIn = useCallback(async () => {
    if (!address || !chainId) return;

    setIsAuthenticating(true);
    setError(null);

    try {
      const siweMessage = new SiweMessage({
        domain: window.location.hostname,
        address,
        statement: 'Sign in to Vicoop Bridge Admin.',
        uri: window.location.origin,
        version: '1',
        chainId,
        nonce: crypto.randomUUID().replace(/-/g, ''),
        issuedAt: new Date().toISOString(),
        expirationTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const message = siweMessage.prepareMessage();
      const signature = await signMessageAsync({ message });
      const accessToken = await exchangeSiweForCallerToken(message, signature);
      setToken(accessToken);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes('user rejected')) {
        setError(msg);
      }
    } finally {
      setIsAuthenticating(false);
    }
  }, [address, chainId, signMessageAsync]);

  useEffect(() => {
    if (isConnected && address && !token && !isAuthenticating && !autoSignInAttempted.current) {
      autoSignInAttempted.current = true;
      signIn();
    }
  }, [isConnected, address, token, isAuthenticating, signIn]);

  useEffect(() => {
    if (!isConnected) {
      autoSignInAttempted.current = false;
      if (token) setToken(null);
    }
  }, [isConnected, token]);

  if (!isConnected) {
    return (
      <div className="flex items-center gap-3">
        <ConnectButton />
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {token ? (
        <>
          <span className="text-sm text-zinc-400 font-mono">
            {address?.slice(0, 6)}...{address?.slice(-4)}
          </span>
          <button
            onClick={() => { setToken(null); disconnect(); }}
            className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Sign out
          </button>
        </>
      ) : (
        <>
          <button
            onClick={signIn}
            disabled={isAuthenticating}
            className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-3 py-1.5 rounded transition-colors disabled:opacity-50"
          >
            {isAuthenticating ? 'Signing...' : 'Sign in'}
          </button>
          {error && <p className="text-sm text-red-400">{error}</p>}
        </>
      )}
    </div>
  );
}
