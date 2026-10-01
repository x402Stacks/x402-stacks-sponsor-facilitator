# x402 Stacks Sponsor Facilitator

A V2 x402 facilitator for Stacks that sponsors transaction fees so payers do not need STX for fees.

It verifies signed STX and allowlisted SIP-010 payments, optionally adds the sponsor signature and fee, broadcasts through Hiro, and waits for a final transaction status. It works with `x402-stacks` SDK `>=2.1.0`: <https://www.npmjs.com/package/x402-stacks>.

## How it works

1. A client requests a protected resource. The resource server returns HTTP `402` payment requirements containing `extra.feePayer` when it offers sponsored payment.
2. The client signs a sponsored transaction with fee `0`; it does not broadcast the transaction.
3. The client retries the resource request with the signed payment. The resource server sends it to this facilitator's `POST /settle` endpoint.
4. The facilitator validates the requirements, signed transaction, payer nonce, mempool state, and balance.
5. For a sponsored transaction, the facilitator adds its signature and configured fee. For a standard transaction, it leaves the payer-paid fee intact.
6. The facilitator broadcasts through Hiro and waits for confirmation. A final success returns `200`; the resource server then grants access.

Standard transactions that pay their own fee can also be settled, including when a fee payer is advertised. Sponsored transactions require the advertised fee payer and an allowlisted `payTo` address.

```text
Client              Resource server             Facilitator             Stacks / Hiro
  | GET resource          |                           |                         |
  |---------------------->|                           |                         |
  |<-- 402 + feePayer ----|                           |                         |
  | sign sponsored tx     |                           |                         |
  | fee = 0               |                           |                         |
  | retry with payment -->|                           |                         |
  |                       | POST /settle ------------>|                         |
  |                       |                           | validate                |
  |                       |                           | sponsor-sign if needed  |
  |                       |                           | broadcast ------------->|
  |                       |                           |<------ confirm ---------|
  |                       |<------- 200 success ------|                         |
  |<------ resource ------|                           |                         |
```

## Quick start

Requires Node.js 22 or later.

```sh
npm install
cp .env.example .env
# Set SPONSOR_PRIVATE_KEY and SPONSOR_PAY_TO in .env
npm run build
npm start
```

The sponsor address derived from `SPONSOR_PRIVATE_KEY` needs STX on each network served. Set `SPONSOR_PAY_TO` to the comma-separated merchant addresses that may use sponsored fees.

### Docker

```sh
docker build -t x402-stacks-sponsor-facilitator .
docker run --env-file .env -p 8085:8085 \
  -v x402-facilitator-data:/app/data \
  x402-stacks-sponsor-facilitator
```

The container listens on `8085` by default. Mount `/app/data` so the daily sponsor budget state survives container replacement. If you change `PORT`, update the published port too.

## Configuration

All variables are read from the process environment. Defaults shown are applied by the application; empty optional values are treated as unset.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPONSOR_PRIVATE_KEY` | Required | Sponsor private key in hex. The process exits if missing or invalid. |
| `SPONSOR_PAY_TO` | Empty | Comma-separated merchant addresses eligible for sponsorship. Empty disables advertising signers and sponsorship. |
| `SPONSOR_DAILY_BUDGET` | `1000000` | Maximum sponsored fees per merchant address per UTC day, in microSTX. |
| `SPONSOR_PAYER_PER_MINUTE` | `10` | Maximum accepted sponsored settle attempts per payer in a rolling 60-second window. Process-local. |
| `STATE_FILE` | `./data/state.json` | JSON file storing daily sponsored fee totals. Writes use a temporary file and rename. |
| `SPONSOR_LOW_BALANCE` | `1000000` | Low balance alert threshold, in microSTX. |
| `ALERT_WEBHOOK_URL` | Unset | Optional URL receiving a JSON `sponsor_low_balance` event, at most once per hour per network. |
| `HIRO_API_KEY` | Unset | Optional key sent to Hiro in the `x-api-key` header; strongly recommended to raise rate limits. |
| `PORT` | `8085` | HTTP listen port. |
| `SPONSOR_FEE` | `10000` | Flat sponsor fee per sponsored transaction, in microSTX. |
| `SPONSOR_MAX_REPAIR_FEE` | `SPONSOR_FEE × 16` | Maximum fee for stuck sponsor nonce replacement, in microSTX (`160000` with the default sponsor fee). |
| `SETTLE_TIMEOUT_MS` | `45000` | Upper bound on how long `/settle` waits for a final transaction status. The requirement's `maxTimeoutSeconds` can shorten it. |

## Integrating with `x402-stacks`

Set the facilitator URL to this service's base URL. The resource server should fetch `/supported` and place the first signer for the chosen CAIP-2 network in the payment requirement's `extra.feePayer`. Set the payment recipient to an address included in `SPONSOR_PAY_TO` if sponsored fees are desired.

### Express resource server

```ts
import express from 'express';
import { paymentMiddleware } from 'x402-stacks';

const app = express();
const facilitatorUrl = process.env.FACILITATOR_URL ?? 'http://localhost:8085';
const network = 'stacks:2147483648'; // Stacks testnet
const supported = await (await fetch(`${facilitatorUrl}/supported`)).json() as {
  signers: Record<string, string[]>;
};
const feePayer = supported.signers[network]?.[0];
if (!feePayer) throw new Error(`No facilitator signer advertised for ${network}`);

const payTo = process.env.PAY_TO!; // Must be in the facilitator's SPONSOR_PAY_TO
app.get(
  '/api/premium-data',
  paymentMiddleware({
    amount: '1000', // microSTX
    payTo,
    network: 'testnet',
    facilitatorUrl,
    extra: { feePayer },
  }),
  (_req, res) => res.json({ data: 'Premium content' }),
);

app.listen(3000);
```

The facilitator's network identifiers are `stacks:1` for mainnet and `stacks:2147483648` for testnet. In the SDK middleware config, `network` is the SDK network name (`mainnet` or `testnet`); the resulting facilitator requirement uses the CAIP-2 identifier.

### Client

The client uses the SDK normally; it handles the 402 response and payment signing. It does not need special sponsor handling.

```ts
import axios from 'axios';
import { createPaymentClient, privateKeyToAccount } from 'x402-stacks';

const account = privateKeyToAccount(process.env.PAYER_PRIVATE_KEY!, 'testnet');
const api = createPaymentClient(account, { baseURL: 'https://api.example.com' });
const response = await api.get('/api/premium-data');
console.log(response.data);
```

`wrapAxiosWithPayment(axios.create({ baseURL }), account)` is the equivalent wrapper form.

### Accepted assets

The facilitator accepts `STX` and the exact, case-sensitive symbols `SBTC` and `USDCX`, or the exact contract identifier. Mixed-case spellings such as `sBTC` and `USDCx` are not accepted as symbols. These are the contract IDs in [`src/tokens.ts`](src/tokens.ts):

| Asset | Mainnet contract | Testnet contract |
| --- | --- | --- |
| SBTC | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` | `ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-token` |
| USDCX | `SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx` | `ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx` |

STX is native and has no contract ID. For sponsored SIP-010 transfers, the transaction must include exactly one matching Deny-mode fungible-token post-condition.

## API reference

All routes are at the service root. JSON request bodies are limited to 64 KiB. `/verify` and `/settle` accept the x402 V2 facilitator envelope.

### `GET /health`

Returns HTTP `200` with the derived sponsor addresses and last observed STX balances. A `null` balance means the monitor has not yet recorded it.

```json
{
  "status": "ok",
  "sponsor": {
    "mainnet": { "address": "SP...", "balance": "2500000" },
    "testnet": { "address": "ST...", "balance": "1200000" }
  }
}
```

`status` is `degraded` if an observed balance on either network is below `SPONSOR_FEE`.

### `GET /supported`

Returns HTTP `200`. `extra` is present in a kind only when sponsorship is enabled by a non-empty `SPONSOR_PAY_TO`; the `signers` arrays are empty when disabled.

```json
{
  "kinds": [
    { "x402Version": 2, "scheme": "exact", "network": "stacks:1", "extra": { "feePayer": "SP..." } },
    { "x402Version": 2, "scheme": "exact", "network": "stacks:2147483648", "extra": { "feePayer": "ST..." } }
  ],
  "extensions": [],
  "signers": {
    "stacks:1": ["SP..."],
    "stacks:2147483648": ["ST..."]
  }
}
```

### `POST /verify`

Request body fields: top-level `x402Version: 2`, `paymentPayload`, and `paymentRequirements`. A structurally valid request returns HTTP `200`, including when payment validation fails. A malformed envelope returns HTTP `400`.

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "accepted": {
      "scheme": "exact", "network": "stacks:2147483648", "amount": "1000",
      "asset": "STX", "payTo": "ST...", "maxTimeoutSeconds": 45,
      "extra": { "feePayer": "ST..." }
    },
    "payload": { "transaction": "0x<origin-signed transaction hex>" }
  },
  "paymentRequirements": {
    "scheme": "exact", "network": "stacks:2147483648", "amount": "1000",
    "asset": "STX", "payTo": "ST...", "maxTimeoutSeconds": 45,
    "extra": { "feePayer": "ST..." }
  }
}
```

Successful response, HTTP `200`:

```json
{ "isValid": true, "payer": "ST..." }
```

Validation failure, HTTP `200`; malformed request, HTTP `400`:

```json
{ "isValid": false, "invalidReason": "invalid_nonce", "payer": "ST..." }
```

### `POST /settle`

Uses the same request body as `/verify`. Success returns HTTP `200`; validation, broadcast, confirmation, or other settlement failures return HTTP `400`. A malformed envelope also returns HTTP `400`.

Success response:

```json
{
  "success": true,
  "payer": "ST...",
  "transaction": "0x<Stacks transaction ID>",
  "network": "stacks:2147483648"
}
```

Failure response:

```json
{
  "success": false,
  "errorReason": "transaction_pending",
  "payer": "ST...",
  "transaction": "0x<Stacks transaction ID>",
  "network": "stacks:2147483648"
}
```

For a rejected request before broadcast, `transaction` is an empty string. Requests larger than 64 KiB receive HTTP `413` with `{ "error": "payload_too_large" }`.

## Validation and security model

| Attack or failure | Mitigation |
| --- | --- |
| Fake token contract implements a misleading `transfer` | Only the STX asset and the network-specific sBTC and USDCx contracts in `src/tokens.ts` are accepted. |
| Impossible post-conditions make a sponsored contract call abort after charging the sponsor | Sponsored STX transfers must have no post-conditions. Sponsored FT transfers must have exactly one matching `Deny` post-condition requiring the payer's exact token transfer. |
| Queued payer transaction drains funds or holds a nonce | Sponsored settlement rejects a payer with a non-null Hiro `last_mempool_tx_nonce`; the payer nonce must also equal `possible_next_nonce`, and the payer must have the payment balance. |
| Duplicate settle or concurrent double access | An in-flight key guards the same network, payer, and nonce. After settlement, the on-chain nonce check rejects replay. |
| Free-fee abuse or sponsor-target abuse | Sponsored `payTo` must be in `SPONSOR_PAY_TO`; a per-merchant daily fee budget and per-payer rolling-minute limit apply. |
| Sponsor nonce gaps or stuck sponsor transaction | Sponsor broadcasts are serialized per network and the nonce is committed only after broadcast succeeds. A repair loop replaces detected missing nonces and escalates a stuck transaction's fee up to `SPONSOR_MAX_REPAIR_FEE`. |
| Unknown chain ID | Only Stacks mainnet and testnet transaction chain IDs and their corresponding x402 network IDs are accepted. |
| Oversized request body | Hono's body limit is 64 KiB and returns HTTP `413`. |

These defenses were exercised on testnet with [`scripts/attack-probes.ts`](scripts/attack-probes.ts). The script submits test transactions and can spend testnet funds.

## Operations

### Logs and health

The application emits JSON log records with these `evt` values:

| `evt` | Meaning |
| --- | --- |
| `settle` | One record per `/settle` outcome, including network, payer, payTo, asset, amount, sponsored flag, result, txid, chain status, and elapsed milliseconds. |
| `sponsor_repair` | Sponsor nonce replacement broadcast, with network, nonce, fee, and txid. |
| `sponsor_low_balance` | Observed sponsor STX balance below `SPONSOR_LOW_BALANCE`; also posted to the configured webhook when eligible. |
| `error` | Operational errors; `where` is `state_load`, `verify`, `settle`, `sponsor_repair:<network>`, `sponsor_balance`, or `sponsor_alert`. |

The monitor reads both network balances at startup and every 60 seconds. `/health` reports `degraded` only after an observed balance is below the configured transaction fee; a missing observation is shown as `null` and does not by itself degrade health. The low-balance log and webhook threshold is separately controlled by `SPONSOR_LOW_BALANCE`.

### Funding and nonce repair

Fund the sponsor address shown by `/supported` (or `/health`) with STX on every network you enable. STX pays sponsor fees and repair fees. The sponsor repair loop runs immediately at startup and then every 60 seconds for mainnet and testnet. It replaces Hiro-detected missing sponsor nonces at `SPONSOR_FEE`. If the first pending sponsor nonce remains stuck for 120 seconds without the last executed nonce advancing, it submits a replacement with an exponentially increased fee, capped at `SPONSOR_MAX_REPAIR_FEE`. A replacement is a one-microSTX STX transfer to the first address in `SPONSOR_PAY_TO`.

Set `HIRO_API_KEY`. Without it, Hiro `429` responses are retried three times, then chain lookup errors can cause `unexpected_verify_error` (or a settlement error). Run exactly **one instance**: the in-flight guard, payer rate limit, and sponsor nonce allocator are process-local. The daily merchant budget is persisted in `STATE_FILE`, but is not a shared multi-instance coordination mechanism.

## Error reasons

`invalidReason` is used by `/verify`; `errorReason` is used by `/settle`. Except for a malformed request envelope, these validation results are returned with HTTP `200` from `/verify`. `/settle` failures use HTTP `400`.

| Reason | Meaning |
| --- | --- |
| `invalid_request` | Request envelope is malformed or required fields are missing. |
| `invalid_x402_version` | Payment payload version is not `2`. |
| `invalid_payload` | Transaction is missing, malformed, has an invalid origin signature, is unsupported, or attempts to sponsor the sponsor itself. |
| `unsupported_scheme` | Requirement scheme is not `exact`. |
| `invalid_network` | Requirement network is unsupported or disagrees with the transaction chain. |
| `invalid_payment_requirements` | `scheme`, `network`, `amount`, `asset`, or `payTo` differs between accepted and required values, or amount is not a positive integer. |
| `invalid_asset` | Asset is not allowlisted or does not match the transaction type/contract/function. |
| `sender_mismatch` | SIP-010 transfer sender argument does not match the transaction payer. |
| `recipient_mismatch` | Transaction recipient differs from `paymentRequirements.payTo`. |
| `amount_mismatch` | Transaction amount differs from the exact required amount. |
| `sponsorship_not_allowed` | Sponsorship is disabled or `payTo` is not in `SPONSOR_PAY_TO`. |
| `fee_payer_mismatch` | Sponsored requirements do not name this network's sponsor in `extra.feePayer`. |
| `invalid_post_conditions` | Sponsored STX has post-conditions, or sponsored FT does not have exactly one. |
| `missing_post_condition` | Sponsored FT lacks the exact payer, asset, amount, and Deny-mode transfer condition. |
| `sponsor_unavailable` | A recorded sponsor balance is below `SPONSOR_FEE`. |
| `sponsor_budget_exceeded` | Adding this fee would exceed the merchant's UTC-day budget. |
| `rate_limited` | Payer exceeded `SPONSOR_PAYER_PER_MINUTE` accepted sponsored settle attempts in 60 seconds. |
| `invalid_nonce` | Payer transaction nonce is not Hiro's `possible_next_nonce`. |
| `payer_has_pending_transactions` | Sponsored payer has a pending mempool nonce. |
| `insufficient_funds` | Payer's unlocked balance of the required asset is below the payment amount. |
| `unexpected_verify_error` | Hiro or another chain lookup failed during validation. |
| `duplicate_payment` | The same network, payer, and nonce is already being settled. |
| `broadcast_failed` | Hiro rejected the transaction broadcast. |
| `transaction_pending` | No final transaction status was observed before the settlement wait ended. |
| `transaction_failed` | Hiro reported `abort_by_response`, `abort_by_post_condition`, or `failed`. |
| `unexpected_settle_error` | An unexpected error occurred while sponsor-signing or broadcasting. |

An oversized body is a separate HTTP error: `413` with `{ "error": "payload_too_large" }`.

## Testing and testnet scripts

`npm test` runs `vitest run`.

The scripts below submit transactions and spend testnet funds unless `replace-nonce.ts` is explicitly configured for mainnet. Use funded test keys and review each script before running.

| Script | Environment variables | What it does |
| --- | --- | --- |
| `scripts/e2e-testnet.ts` | Required: `PAYER_PRIVATE_KEY`, `PAY_TO`. Optional: `FACILITATOR_URL` (default `http://localhost:8085`). | Signs and settles one 1000-microSTX sponsored testnet STX payment. |
| `scripts/e2e-matrix.ts` | Required: `PAYER_PRIVATE_KEY`, `PAY_TO`. Optional: `FACILITATOR_URL` (default `http://localhost:8085`). | Runs 11 testnet scenarios covering standard and sponsored settlements, replay, mismatches, insufficient funds, nonce handling, concurrency, and post-concurrency settlement. |
| `scripts/attack-probes.ts` | Required: `PAYER_PRIVATE_KEY`, `PAY_TO`. Optional: `FACILITATOR_URL` (default `http://localhost:8085`). | Probes bogus chain IDs, impossible post-conditions, duplicate standard settles, pending payer drain, and disallowed sponsored recipients. The pending-drain probe broadcasts a payer transaction. |
| `scripts/replace-nonce.ts` | Required: `KEY`, `NONCE`, `FEE`, `TO`. Optional: `NETWORK` (`testnet` default; `testnet` or `mainnet`), `HIRO_API_KEY`. | Signs and broadcasts a one-microSTX STX transfer using the supplied nonce and fee, typically to replace a stuck transaction. It spends the selected network's funds. |

Run the TypeScript scripts with `npx tsx`, for example:

```sh
npx tsx scripts/e2e-testnet.ts
npx tsx scripts/e2e-matrix.ts
npx tsx scripts/attack-probes.ts
KEY=... NONCE=... FEE=... TO=... npx tsx scripts/replace-nonce.ts
```

## Known limits

- The facilitator implements its own V2 scheme and does not yet migrate to `@x402/core`.
- One sponsor key can have about 25 chained pending transactions; there is no sponsor key pool.
- Sponsor fees use one flat configurable fee rather than dynamic fee estimation.
- Payers must use single-signature P2PKH transactions. Only exact STX, sBTC, and USDCx transfers are supported.
- Only Stacks mainnet and testnet are supported. V1 routes are not implemented.
- Sponsor nonce state, in-flight protection, and payer rate limiting are in memory and require exactly one running instance.

## Migrating from the Go facilitator

The root V2 routes are compatible with the Go facilitator contract: `GET /supported`, `POST /verify`, and `POST /settle`. V1 routes (`/api/v1/verify` and `/api/v1/settle`) are not implemented here, so V1 clients must keep using a V1-capable facilitator. V2 payments must match the requested amount exactly, and unknown assets or token contracts are rejected. For sponsored payments, configure `SPONSOR_PAY_TO` and ensure the requirement includes the matching `extra.feePayer` from `/supported`.

## License

MIT
