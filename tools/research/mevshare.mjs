// Were our test deposits offered to searchers through Flashbots' MEV-Share? Its history lists a double hash per hinted transaction.
import { keccak256 } from 'viem'
const deps = { '12:41 public 40': ['0xe24fd75b7fb9371178a7c520e6a5f88c147011bb9d35122af0d8277ea05f8367', 26497343], '12:43 public 21': ['0x1e542b086d043af8a1d6c40fbfea574ac6fa234c7c81b145f85ef3f865a1f81b', 26497353], '12:27 private 40 (BuilderNet)': ['0x68ade9a4da64bf643381f703abcfd2dc1b4d620d41a80c6c5a7beca5d837a83b', 26497262] }
const info = await (await fetch('https://mev-share.flashbots.net/api/v1/history/info')).json().catch((e) => ({ error: String(e) }))
console.log('history info', JSON.stringify(info).slice(0, 200))
for (const [name, [h, start]] of Object.entries(deps)) {
  const dh = keccak256(h)
  let found = null, n = 0
  for (let off = 0; off < 6000 && !found; off += 500) {
    const r = await fetch(`https://mev-share.flashbots.net/api/v1/history?blockStart=${start}&blockEnd=${start + 4}&limit=500&offset=${off}`).then((x) => x.json()).catch(() => [])
    if (!Array.isArray(r) || !r.length) break
    n += r.length
    found = r.find((e) => e.hint?.hash === dh || (e.hint?.txs ?? []).some((t) => t.hash === h)) ?? null
  }
  console.log(name.padEnd(30), 'hints scanned', n, '|', found ? 'OFFERED on MEV-Share at block ' + found.block + ': ' + JSON.stringify(found.hint).slice(0, 300) : 'not in MEV-Share')
}
