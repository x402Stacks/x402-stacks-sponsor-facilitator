# x402-stacks-sponsor-facilitator

x402 facilitator for Stacks that sponsors transaction fees

## Quick start

```sh
npm install
cp .env.example .env
# Set SPONSOR_PRIVATE_KEY and SPONSOR_PAY_TO in .env
npm run build && npm start
```

To run with Docker, build the image and mount persistent state at `/app/data`:

```sh
docker build -t x402-stacks-sponsor-facilitator .
docker run --env-file .env -p 8085:8085 -v x402-facilitator-data:/app/data x402-stacks-sponsor-facilitator
```

## Overview

A standalone x402 V2 facilitator for Stacks. It verifies client signed STX and allowlisted SIP-010 payments, adds the sponsor signature and fee to sponsored transactions, broadcasts them through Hiro, and waits for confirmation.

## Endpoints

- `GET /supported` advertises the exact scheme, supported networks, and sponsor fee payer addresses.
- `GET /health` returns a health status.
- `POST /verify` validates a payment payload against its requirements and current payer nonce and balance.
- `POST /settle` validates, sponsors when requested, broadcasts, and waits for the transaction result.

The `/verify` and `/settle` request bodies use the x402 V2 facilitator contract: `x402Version`, `paymentPayload`, and `paymentRequirements`.

## Configuration

Copy `.env.example` to `.env` and configure the sponsor key and any optional settings. The sponsor address needs STX on each network it serves.

| Variable | Description | Default |
| --- | --- | --- |
| `SPONSOR_PRIVATE_KEY` | Sponsor private key in hex | Required |
| `SPONSOR_PAY_TO` | Comma-separated merchant addresses eligible for sponsored fees; empty disables sponsorship | Empty |
| `SPONSOR_DAILY_BUDGET` | Maximum sponsor fees in microSTX per merchant address per UTC day | `1000000` |
| `SPONSOR_PAYER_PER_MINUTE` | Sponsored settles allowed per payer in a rolling 60-second window | `10` |
| `STATE_FILE` | JSON file for daily sponsor fee counters; persisted with an atomic rename | `./data/state.json` |
| `SPONSOR_LOW_BALANCE` | Log and alert threshold for sponsor STX balance in microSTX | `1000000` |
| `ALERT_WEBHOOK_URL` | Optional URL that receives low-balance JSON alerts at most once per hour per network | None |
| `HIRO_API_KEY` | Optional key sent to Hiro as `x-api-key`; set one to raise Hiro's API rate limits | None |
| `PORT` | HTTP port (`8085` matches the SDK default) | `8085` |
| `SPONSOR_FEE` | Flat sponsor fee per transaction in microSTX | `10000` |
| `SPONSOR_MAX_REPAIR_FEE` | Maximum fee in microSTX for a stuck sponsor nonce replacement | `SPONSOR_FEE × 16` (`160000` when the default fee is used) |
| `SETTLE_TIMEOUT_MS` | Maximum time `/settle` waits for confirmation | `45000` |

Run exactly **one instance**. The duplicate-payment guard, sponsor nonce allocator, and payer rate limits are per-process. The daily sponsor fee budget is persisted in `STATE_FILE`.

## How sponsorship works

The resource server calls `GET /supported` and uses the matching network's `signers` entry as `extra.feePayer` in its payment requirements. `SPONSOR_PAY_TO` must include the merchant address for sponsored fees to be offered. When a requirement carries that fee payer, the client signs with `sponsored: true` and `fee: 0`. The facilitator verifies the origin signature and payment, adds its sponsor signature and configured fee, then broadcasts the transaction. Requirements without `extra.feePayer` can also use standard, non-sponsored transactions.

## Validation rules

- Only the `exact` scheme and supported Stacks mainnet or testnet network are accepted.
- The accepted option must match the payment requirements for scheme, network, amount, asset, and recipient.
- The amount must be a valid exact amount; only STX and allowlisted sBTC and USDCx contracts are accepted.
- The transaction must be a valid origin-signed single-sig payment to the required recipient. For FT transfers, the transfer sender must be the payer.
- Sponsored payments must name this facilitator as `feePayer`; FT sponsorship also requires Deny post-condition mode with an exact transfer post-condition.
- The transaction nonce must equal the payer's next on-chain nonce, and the payer must have enough unlocked balance for the payment.

## Known limits

- The facilitator does not yet migrate to `@x402/core`.
- One sponsor key can have about 25 chained pending transactions; there is no sponsor key pool.
- Sponsor fees use a flat configurable amount rather than dynamic fee estimation.

## Error reasons

`invalid_request`, `invalid_x402_version`, `invalid_payload`, `unsupported_scheme`, `invalid_network`, `invalid_payment_requirements`, `invalid_asset`, `sponsorship_not_allowed`, `fee_payer_mismatch`, `amount_mismatch`, `recipient_mismatch`, `sender_mismatch`, `invalid_post_conditions`, `missing_post_condition`, `invalid_nonce`, `payer_has_pending_transactions`, `insufficient_funds`, `sponsor_unavailable`, `sponsor_budget_exceeded`, `rate_limited`, `duplicate_payment`, `broadcast_failed`, `transaction_pending`, `transaction_failed`, `unexpected_verify_error`, and `unexpected_settle_error`.

## Migrating from the Go facilitator

V2 routes are compatible with the Go facilitator. V1 routes (`/api/v1/verify` and `/api/v1/settle`) are not implemented here, so keep the Go facilitator running for V1 clients. Payment amounts must now match exactly, and unknown assets are rejected.
