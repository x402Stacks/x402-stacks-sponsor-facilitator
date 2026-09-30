import {
  Cl,
  type ClarityValue,
  makeContractCall,
  makeSTXTokenTransfer,
  Pc,
  type PostCondition,
  PostConditionMode,
  postConditionToWire,
  privateKeyToAddress,
  randomPrivateKey,
  TransactionSigner,
} from '@stacks/transactions';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentPayload, PaymentRequirements } from '../src/types.js';

export const TESTNET = 'stacks:2147483648';
export const SBTC = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-token';
export const FAKE_SBTC = 'ST2K48AP2251KJ45GEZNEEXG4EV8WQBYRPKT13BG9.sbtc-token';

export const payerKey = randomPrivateKey();
export const payer = privateKeyToAddress(payerKey, 'testnet');
export const sponsorKey = randomPrivateKey();
export const sponsor = privateKeyToAddress(sponsorKey, 'testnet');
export const payTo = privateKeyToAddress(randomPrivateKey(), 'testnet');

export function testStateFile(): string {
  return join(tmpdir(), `x402-stacks-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

export async function stxTx(
  o: { amount?: bigint; recipient?: string; sponsored?: boolean; nonce?: number; key?: string; memo?: string; postConditions?: PostCondition[] } = {},
): Promise<string> {
  const sponsored = o.sponsored ?? true;
  const tx = await makeSTXTokenTransfer({
    recipient: o.recipient ?? payTo,
    amount: o.amount ?? 1000n,
    senderKey: o.key ?? payerKey,
    network: 'testnet',
    memo: o.memo ?? 'x402:test',
    postConditions: o.postConditions,
    sponsored,
    fee: sponsored ? 0 : 500,
    nonce: o.nonce ?? 0,
  });
  if (o.postConditions) {
    tx.postConditions.values = o.postConditions.map(postConditionToWire);
    new TransactionSigner(tx).signOrigin(o.key ?? payerKey);
  }
  return tx.serialize();
}

export async function ftTx(
  o: { contract?: string; amount?: bigint; sender?: string; deny?: boolean; nonce?: number; memo?: ClarityValue; postConditions?: PostCondition[] } = {},
): Promise<string> {
  const contract = (o.contract ?? SBTC) as `${string}.${string}`;
  const [contractAddress, contractName] = contract.split('.');
  const amount = o.amount ?? 1000n;
  const deny = o.deny ?? true;
  const tx = await makeContractCall({
    contractAddress,
    contractName,
    functionName: 'transfer',
    functionArgs: [
      Cl.uint(amount),
      Cl.principal(o.sender ?? payer),
      Cl.principal(payTo),
      o.memo ?? Cl.some(Cl.bufferFromUtf8('x402:test')),
    ],
    senderKey: payerKey,
    network: 'testnet',
    sponsored: true,
    fee: 0,
    nonce: o.nonce ?? 0,
    postConditionMode: deny ? PostConditionMode.Deny : PostConditionMode.Allow,
    postConditions: o.postConditions ?? (deny ? [Pc.principal(payer).willSendEq(amount).ft(contract, 'sbtc-token')] : []),
  });
  return tx.serialize();
}

export function requirements(o: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: TESTNET,
    amount: '1000',
    asset: 'STX',
    payTo,
    maxTimeoutSeconds: 60,
    extra: { feePayer: sponsor },
    ...o,
  };
}

export function payloadFor(transaction: string, req: PaymentRequirements): PaymentPayload {
  return { x402Version: 2, accepted: req, payload: { transaction } };
}
