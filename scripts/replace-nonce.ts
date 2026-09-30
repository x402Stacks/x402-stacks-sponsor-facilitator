import { makeSTXTokenTransfer, privateKeyToAddress } from '@stacks/transactions';

type NetworkName = 'testnet' | 'mainnet';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function unsignedInteger(name: string, value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return BigInt(value);
}

async function main(): Promise<void> {
  const privateKey = requiredEnv('KEY');
  if (!/^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{66})$/.test(privateKey)) {
    throw new Error('KEY must be a 32-byte private key in hex (optionally with the compressed-key suffix)');
  }

  const nonce = unsignedInteger('NONCE', requiredEnv('NONCE'));
  const fee = unsignedInteger('FEE', requiredEnv('FEE'));
  const recipient = requiredEnv('TO');
  const networkValue = process.env.NETWORK?.trim() || 'testnet';
  if (networkValue !== 'testnet' && networkValue !== 'mainnet') {
    throw new Error("NETWORK must be 'testnet' or 'mainnet'");
  }
  const network: NetworkName = networkValue;
  const sender = privateKeyToAddress(privateKey, network);

  const transaction = await makeSTXTokenTransfer({
    recipient,
    amount: 1n,
    senderKey: privateKey,
    network,
    nonce,
    fee,
    memo: 'x402:replace',
  });

  const hiroUrl = network === 'testnet' ? 'https://api.testnet.hiro.so' : 'https://api.hiro.so';
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
  const apiKey = process.env.HIRO_API_KEY?.trim();
  if (apiKey) headers['x-api-key'] = apiKey;

  console.log(`sender: ${sender}`);
  console.log(`nonce: ${nonce}`);
  console.log(`fee: ${fee}`);

  const response = await fetch(`${hiroUrl}/v2/transactions`, {
    method: 'POST',
    headers,
    body: Buffer.from(transaction.serialize(), 'hex'),
  });

  const responseText = await response.text();
  let result: unknown;
  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch {
    result = { error: responseText || response.statusText, status: response.status };
  }
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok) process.exitCode = 1;
}

main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
