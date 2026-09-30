import type { StacksNet } from './types.js';

export interface Token {
  contract: string; // "<address>.<contract-name>"
  assetName: string; // define-fungible-token name
}

// Only these SIP-010 contracts are accepted (and sponsored). An unknown contract could
// fake a `transfer` that moves nothing.
const TOKENS: Record<StacksNet, Record<string, Token>> = {
  mainnet: {
    SBTC: { contract: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token', assetName: 'sbtc-token' },
    USDCX: { contract: 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx', assetName: 'usdcx-token' },
  },
  testnet: {
    SBTC: { contract: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-token', assetName: 'sbtc-token' },
    USDCX: { contract: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx', assetName: 'usdcx-token' },
  },
};

/** asset is "STX", a symbol ("SBTC", "USDCX") or a contract id. null = not allowlisted. */
export function resolveAsset(asset: string, net: StacksNet): 'STX' | Token | null {
  if (asset === 'STX') return 'STX';
  const tokens = TOKENS[net];
  return tokens[asset] ?? Object.values(tokens).find((t) => t.contract === asset) ?? null;
}
