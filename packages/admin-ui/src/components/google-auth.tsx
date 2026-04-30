// Google OAuth login button for the admin UI. Drives the bridge's
// device flow with intent=caller behind a popup so the user signs in
// to Google in a separate window; the parent page polls the token
// endpoint and stores the resulting vbc_caller_* in the same auth-token
// localStorage slot used by SIWE. Google operators reach the chat via
// is_admin()-gated RLS scope (admin agent at POST / no longer rejects
// non-eth principals as of the issue #79 option-B server change).

import { useCallback, useRef, useState } from 'react';
import { setToken } from '../lib/auth-token';
import { startDeviceFlow, type DeviceFlowSession } from '../lib/device-flow';

interface State {
  status: 'idle' | 'awaiting' | 'error';
  userCode?: string;
  error?: string;
}

export function GoogleAuth() {
  const [state, setState] = useState<State>({ status: 'idle' });
  const sessionRef = useRef<DeviceFlowSession | null>(null);
  const popupRef = useRef<Window | null>(null);

  const cancel = useCallback(() => {
    sessionRef.current?.cancel();
    sessionRef.current = null;
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close();
    }
    popupRef.current = null;
    setState({ status: 'idle' });
  }, []);

  const signIn = useCallback(async () => {
    // Synchronously open the popup as part of the user gesture so popup
    // blockers don't kill it. Navigate to the verification URL once the
    // device-code response lands.
    const popup = window.open('about:blank', 'vicoop-bridge-google-auth', 'width=480,height=640');
    if (!popup) {
      setState({ status: 'error', error: 'Popup blocked. Allow popups for this site and try again.' });
      return;
    }
    popupRef.current = popup;

    setState({ status: 'awaiting' });
    let session: DeviceFlowSession;
    try {
      session = await startDeviceFlow();
    } catch (err) {
      popup.close();
      popupRef.current = null;
      setState({ status: 'error', error: (err as Error).message });
      return;
    }
    sessionRef.current = session;
    popup.location.href = session.verificationUriComplete;
    setState({ status: 'awaiting', userCode: session.userCode });

    try {
      const token = await session.result;
      setToken(token);
      // Token is set; parent App will swap to Chat. Close the popup if the
      // user didn't already.
      if (popup && !popup.closed) popup.close();
      sessionRef.current = null;
      popupRef.current = null;
      setState({ status: 'idle' });
    } catch (err) {
      if (popup && !popup.closed) popup.close();
      sessionRef.current = null;
      popupRef.current = null;
      const msg = (err as Error).message;
      // Don't surface "canceled" as an error — that's the user clicking cancel.
      if (msg === 'canceled') {
        setState({ status: 'idle' });
      } else {
        setState({ status: 'error', error: msg });
      }
    }
  }, []);

  if (state.status === 'awaiting') {
    return (
      <div className="flex items-center gap-3">
        <span className="text-sm text-zinc-400">
          Waiting for Google sign-in
          {state.userCode ? <> (code <code>{state.userCode}</code>)</> : null}…
        </span>
        <button
          onClick={cancel}
          className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={signIn}
        className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-3 py-1.5 rounded transition-colors"
      >
        Sign in with Google
      </button>
      {state.status === 'error' && state.error && (
        <p className="text-sm text-red-400">{state.error}</p>
      )}
    </div>
  );
}
