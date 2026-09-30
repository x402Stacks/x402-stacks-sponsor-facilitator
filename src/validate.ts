import { PostConditionMode } from '@stacks/transactions';
import type { DecodedPayment } from './decode.js';
import { resolveAsset, type Token } from './tokens.js';
import { type PaymentRequirements, stacksNetworkName } from './types.js';

const MATCH_FIELDS = ['scheme', 'network', 'amount', 'asset', 'payTo'] as const;

/** Pure checks. Returns an x402 invalidReason, or null when the payment is acceptable. */
export function validatePayment(
  d: DecodedPayment,
  req: PaymentRequirements,
  accepted: PaymentRequirements,
  sponsor: { address: string; payTo: string[] },
): string | null {
  if (req.scheme !== 'exact') return 'unsupported_scheme';
  const net = stacksNetworkName(req.network);
  if (!net || net !== d.network) return 'invalid_network';
  if (!MATCH_FIELDS.every((k) => req[k] === accepted?.[k])) return 'invalid_payment_requirements';

  let amount: bigint;
  try {
    amount = BigInt(req.amount);
  } catch {
    return 'invalid_payment_requirements';
  }
  if (amount <= 0n) return 'invalid_payment_requirements';

  const asset = resolveAsset(req.asset, net);
  if (!asset) return 'invalid_asset';
  if (asset === 'STX' ? d.kind !== 'stx' : d.kind !== 'ft' || d.contract !== asset.contract || d.functionName !== 'transfer') {
    return 'invalid_asset';
  }
  if (d.kind === 'ft' && d.sender !== d.payer) return 'sender_mismatch';
  if (d.recipient !== req.payTo) return 'recipient_mismatch';
  if (d.amount !== amount) return 'amount_mismatch'; // "exact" scheme

  if (d.sponsored) {
    // We only sponsor what the resource server asked us to sponsor.
    if (sponsor.payTo.length === 0) return 'sponsorship_not_allowed';
    if (req.extra?.feePayer !== sponsor.address) return 'fee_payer_mismatch';
    if (!sponsor.payTo.includes(req.payTo)) return 'sponsorship_not_allowed';
    if (d.payer === sponsor.address) return 'invalid_payload';
    if (asset === 'STX' && d.postConditions.length !== 0) return 'invalid_post_conditions';
    // A sponsored contract call that aborts still costs us the fee: require Deny mode with
    // exactly the payment transfer allowed.
    if (asset !== 'STX') {
      if (d.postConditions.length !== 1) return 'invalid_post_conditions';
      if (!coversTransfer(d, asset, amount)) return 'missing_post_condition';
    }
  }
  return null;
}

function coversTransfer(d: DecodedPayment, token: Token, amount: bigint): boolean {
  return (
    d.postConditionMode === PostConditionMode.Deny &&
    d.postConditions.some(
      (pc) =>
        pc.type === 'ft-postcondition' &&
        pc.address === d.payer &&
        pc.condition === 'eq' &&
        BigInt(pc.amount) === amount &&
        pc.asset === `${token.contract}::${token.assetName}`,
    )
  );
}
