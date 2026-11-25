[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/top234/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1-entry/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/top234/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1-entry/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

# Tiny Bot — Two-Horizon Trend Follower

Entry for [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) (make.fun, `bars-replay/v1`, hourly bars, 7 Solana symbols, $10,000 USDC starting capital).

## Strategy

Most hourly moves are noise, but short bursts of momentum persist for a few bars and genuine trends persist much longer — so the bot runs two independent trend sleeves:

- **Core (slow):** EMA(6) crossing above EMA(16) while the 12h return tops 2%. Buys up to 20% of equity per symbol, rides the trend with a volatility trailing stop (3× trailing 48h hourly volatility), a −6% stop and a +50% take-profit, exits when EMA(6) crosses back under EMA(16).
- **Fast sleeve:** EMA(4) crossing above EMA(8) while the 3h return tops 0.5%. Small 5% stakes, tight −2% stop / +5% take / 8-bar max hold: it harvests the frequent short bursts and keeps the bot trading through flat stretches instead of sitting idle.

## Risk rules

Long only, at most 5 open positions, at most 25% weight per symbol, sells before buys, at most 16 orders per bar, 1% slippage cap per order (a gapped open is skipped, not chased). Fully deterministic: plain float64 math in a fixed order, no clock, no randomness, no environment, no network, no file writes at runtime.

## Dev-window result (official local grader)

| | |
| --- | --- |
| Net PnL | **+83.98 USDC** (+0.84%) |
| Buy-and-hold baseline | −869.34 USDC |
| Trades | 66 over 7 symbols |
| Max drawdown | 1.14% |
| Guardrails | met |

## Run

```sh
node main.ts
```

`main.ts` speaks `agent-fun/bars-replay/v1` on stdin/stdout via the vendored `vendor/makefun-bars.ts` shim from the competition kit.
