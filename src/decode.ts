import { ChainId } from '@stacks/network';
import {
  AddressHashMode,
  AddressVersion,
  addressToString,
  AuthType,
  ClarityType,
  type ClarityValue,
  cvToValue,
  deserializeTransaction,
  isSingleSig,
  PayloadType,
  type PostCondition,
  PostConditionMode,
  StacksWireType,
  type StacksTransactionWire,
  wireToPostCondition,
} from '@stacks/transactions';
import type { StacksNet } from './types.js';

export interface DecodedPayment {
  tx: StacksTransactionWire;
  sponsored: boolean;
  payer: string;
  network: StacksNet;
  kind: 'stx' | 'ft';
  contract?: string; // "<address>.<name>" for ft
  functionName?: string;
  sender?: string; // ft transfer `sender` arg
  recipient: string;
  amount: bigint;
  nonce: bigint;
  postConditionMode: PostConditionMode;
  postConditions: PostCondition[];
}

const isPrincipal = (cv: ClarityValue | undefined) =>
  cv?.type === ClarityType.PrincipalStandard || cv?.type === ClarityType.PrincipalContract;

/** Throws on anything that is not a validly origin-signed single-sig STX or SIP-010 transfer. */
export function decodePayment(txHex: string): DecodedPayment {
  const tx = deserializeTransaction(txHex.replace(/^0x/, ''));
  tx.verifyOrigin(); // throws if the origin signature does not match the tx contents

  const cond = tx.auth.spendingCondition;
  if (!isSingleSig(cond) || cond.hashMode !== AddressHashMode.P2PKH) {
    throw new Error('only single-sig P2PKH payers are supported');
  }
  if (tx.chainId !== ChainId.Mainnet && tx.chainId !== ChainId.Testnet) {
    throw new Error('unsupported Stacks chain id');
  }
  const network: StacksNet = tx.chainId === ChainId.Mainnet ? 'mainnet' : 'testnet';
  const version = network === 'mainnet' ? AddressVersion.MainnetSingleSig : AddressVersion.TestnetSingleSig;
  const payer = addressToString({ type: StacksWireType.Address, version, hash160: cond.signer });

  const base = {
    tx,
    sponsored: tx.auth.authType === AuthType.Sponsored,
    payer,
    network,
    nonce: BigInt(cond.nonce),
    postConditionMode: tx.postConditionMode,
    postConditions: tx.postConditions.values.map((pc) => wireToPostCondition(pc)),
  };

  const p = tx.payload;
  if (p.payloadType === PayloadType.TokenTransfer) {
    return { ...base, kind: 'stx', recipient: cvToValue(p.recipient) as string, amount: BigInt(p.amount) };
  }
  if (p.payloadType === PayloadType.ContractCall) {
    const [amount, sender, recipient, memo] = p.functionArgs;
    if (p.functionArgs.length !== 4 || amount?.type !== ClarityType.UInt || !isPrincipal(sender) || !isPrincipal(recipient)) {
      throw new Error('not a SIP-010 transfer(amount, sender, recipient, memo) call');
    }
    if (
      memo?.type !== ClarityType.OptionalNone &&
      !(memo?.type === ClarityType.OptionalSome && memo.value.type === ClarityType.Buffer && memo.value.value.length / 2 <= 34)
    ) {
      throw new Error('invalid SIP-010 transfer memo');
    }
    return {
      ...base,
      kind: 'ft',
      contract: `${addressToString(p.contractAddress)}.${p.contractName.content}`,
      functionName: p.functionName.content,
      sender: cvToValue(sender) as string,
      recipient: cvToValue(recipient) as string,
      amount: BigInt(cvToValue(amount) as bigint),
    };
  }
  throw new Error('unsupported payload type');
}
