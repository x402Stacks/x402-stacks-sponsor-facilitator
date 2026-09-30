import { describe, expect, it } from 'vitest';
import { resolveAsset } from '../src/tokens.js';
import { stacksNetworkName } from '../src/types.js';

describe('resolveAsset', () => {
  it('resolves STX', () => expect(resolveAsset('STX', 'testnet')).toBe('STX'));
  it('resolves symbols', () =>
    expect(resolveAsset('SBTC', 'testnet')).toEqual({
      contract: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-token',
      assetName: 'sbtc-token',
    }));
  it('resolves allowlisted contract ids', () =>
    expect(resolveAsset('SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx', 'mainnet')).toEqual({
      contract: 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx',
      assetName: 'usdcx-token',
    }));
  it('rejects unknown contracts', () =>
    expect(resolveAsset('ST2K48AP2251KJ45GEZNEEXG4EV8WQBYRPKT13BG9.sbtc-token', 'testnet')).toBeNull());
  it('does not mix networks', () =>
    expect(resolveAsset('SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token', 'testnet')).toBeNull());
});

describe('stacksNetworkName', () => {
  it('maps CAIP-2 ids', () => {
    expect(stacksNetworkName('stacks:1')).toBe('mainnet');
    expect(stacksNetworkName('stacks:2147483648')).toBe('testnet');
    expect(stacksNetworkName('eip155:1')).toBeNull();
  });
});
