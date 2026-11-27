import { createPublicClient, http, hexToString } from 'viem'
import { mainnet } from 'viem/chains'
const c = createPublicClient({ chain: mainnet, transport: http('https://eth.drpc.org') })
const a = BigInt(process.argv[2]), b = BigInt(process.argv[3])
for (let n = a; n <= b; n++) { const x = await c.getBlock({ blockNumber: n }).catch(() => null); if (x) console.log(n, JSON.stringify(hexToString(x.extraData).replace(/[^\x20-\x7e]/g, '')), x.miner.slice(0, 10)) }
