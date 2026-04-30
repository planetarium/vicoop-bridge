import { useConnectModal } from '@rainbow-me/rainbowkit';
import { useAccount, useSignMessage, useDisconnect } from 'wagmi';
import { SiweMessage } from 'siwe';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthSession, setSession } from '../lib/auth-token';
import { exchangeSiweForCallerToken } from '../lib/siwe-exchange';

export function WalletAuth() {
  const { address, isConnected, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();
  const { openConnectModal } = useConnectModal();
  const session = useAuthSession();
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoSignInAttempted = useRef(false);

  const signIn = useCallback(async () => {
    if (!address || !chainId) return;

    setIsAuthenticating(true);
    setError(null);

    try {
      // Share a single base timestamp between issuedAt and expirationTime so
      // their difference is exactly 7 days. Two separate Date reads can drift
      // a few ms apart and push `expires - issued` over the server's cap.
      const now = Date.now();
      const siweMessage = new SiweMessage({
        domain: window.location.hostname,
        address,
        statement: 'Sign in to Vicoop Bridge Admin.',
        uri: window.location.origin,
        version: '1',
        chainId,
        nonce: crypto.randomUUID().replace(/-/g, ''),
        issuedAt: new Date(now).toISOString(),
        expirationTime: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const message = siweMessage.prepareMessage();
      const signature = await signMessageAsync({ message });
      const accessToken = await exchangeSiweForCallerToken(message, signature);
      setSession({ token: accessToken, provider: 'wallet' });
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
    // Auto-attempt SIWE on a fresh wallet connection only when there's
    // no live session (or the live session belongs to another provider
    // — we don't want to auto-overwrite a Google sign-in).
    const hasWalletSession = session?.provider === 'wallet';
    if (
      isConnected &&
      address &&
      !hasWalletSession &&
      !session &&
      !isAuthenticating &&
      !autoSignInAttempted.current
    ) {
      autoSignInAttempted.current = true;
      signIn();
    }
  }, [isConnected, address, session, isAuthenticating, signIn]);

  useEffect(() => {
    // Reset the auto-sign-in latch on disconnect so a future reconnect
    // can attempt SIWE again. The session is left alone — clearing it
    // here would also nuke an unrelated Google session, and the user
    // can always Sign out explicitly.
    if (!isConnected) {
      autoSignInAttempted.current = false;
    }
  }, [isConnected]);

  if (!isConnected) {
    return (
      <div className="flex items-center gap-3">
        <button
          onClick={openConnectModal}
          className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-3 py-1.5 rounded transition-colors"
        >
          Connect Wallet
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {session?.provider === 'wallet' ? (
        <>
          <span className="text-sm text-zinc-400 font-mono">
            {address?.slice(0, 6)}...{address?.slice(-4)}
          </span>
          <button
            onClick={() => { setSession(null); disconnect(); }}
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
