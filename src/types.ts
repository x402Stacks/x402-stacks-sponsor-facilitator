export type StacksNet = 'mainnet' | 'testnet';

export const NETWORK_IDS = ['stacks:1', 'stacks:2147483648'] as const;

export function stacksNetworkName(network: string): StacksNet | null {
  if (network === 'stacks:1') return 'mainnet';
  if (network === 'stacks:2147483648') return 'testnet';
  return null;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  resource?: unknown;
  accepted: PaymentRequirements;
  payload: { transaction?: unknown };
  extensions?: Record<string, unknown>;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
}
