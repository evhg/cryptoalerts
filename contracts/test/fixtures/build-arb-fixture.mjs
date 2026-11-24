// Builds test/fixtures/arb.json: real KyberSwap router calldata for the arb
// fork tests, built for a fixed contract address at the current mainnet block.
// Run: node test/fixtures/build-arb-fixture.mjs   (needs network)
import { writeFileSync } from 'node:fs'

const RPC = process.env.MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com'
const USDS = '0xdC035D45d973E3EC169d2276DDab16f1e407384F'
const ST = '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9'
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const ARB = '0x00000000000000000000000000000000A4b17000' // test deploys the arb contract here
const ATTACKER = '0x000000000000000000000000000000000BADBAD0'
const KYBER = 'https://aggregator-api.kyberswap.com/ethereum/api/v1'
const H = { 'x-client-id': 'stusds-arb-tests', 'content-type': 'application/json' }

const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result

async function route(tokenIn, tokenOut, amountIn, recipient) {
  const q = await (await fetch(`${KYBER}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`, { headers: H })).json()
  if (!q.data) throw new Error('route: ' + JSON.stringify(q).slice(0, 200))
  const b = await (await fetch(`${KYBER}/route/build`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ routeSummary: q.data.routeSummary, sender: ARB, recipient, slippageTolerance: 300, deadline: Math.floor(Date.now() / 1000) + 86400 * 365, skipSimulateTx: true }),
  })).json()
  if (b.code !== 0) throw new Error('build: ' + JSON.stringify(b).slice(0, 200))
  return { amountIn: amountIn.toString(), amountOut: b.data.amountOut, router: b.data.routerAddress, data: b.data.data }
}

const block = parseInt(await rpc('eth_blockNumber', []), 16)
const e18 = 10n ** 18n
const fx = {
  block,
  arb: ARB,
  attacker: ATTACKER,
  buy20k: await route(USDS, ST, 20_000n * e18, ARB),
  buy100k: await route(USDS, ST, 100_000n * e18, ARB),
  buy20kToAttacker: await route(USDS, ST, 20_000n * e18, ATTACKER),
  tip500: await route(USDS, ETH, 500n * e18, ARB),
}
writeFileSync(new URL('./arb.json', import.meta.url), JSON.stringify(fx, null, 2))
console.log('fixture at block', block, 'router', fx.buy20k.router, 'buy20k ->', Number(fx.buy20k.amountOut) / 1e18, 'stUSDS; buy100k ->', Number(fx.buy100k.amountOut) / 1e18, '; tip500 ->', Number(fx.tip500.amountOut) / 1e18, 'ETH')
