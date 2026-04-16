import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { mainnet, sepolia } from 'wagmi/chains';

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '';

export const config = getDefaultConfig({
  appName: 'Vicoop Bridge Admin',
  projectId,
  chains: [mainnet, sepolia],
});

declare module 'wagmi' {
  interface Register {
    config: typeof config;
  }
}
