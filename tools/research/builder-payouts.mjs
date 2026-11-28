const rpc = 'https://eth.drpc.org';
const call = async (method, params) => { const j = await (await fetch(rpc, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0', id:1, method, params})})).json(); if (j.error) throw new Error(method+' '+JSON.stringify(j.error)); return j.result; };
const f = (w) => (Number(BigInt(w))/1e18).toFixed(6);
for (const a of ['0xfeeeeeeaea9b3ce71ce8a252aaa11d2dc439cc69','0xfeeeeee44046c3f61a8cc081e0918ef0de0a7ffc']) console.log(a, await call('eth_getCode', [a,'latest']));
for (const bn of [26507073, 26501178, 26485404, 26485185, 26478867]) {
  const b = await call('eth_getBlockByNumber', ['0x'+bn.toString(16), true]);
  const tr = await call('trace_block', ['0x'+bn.toString(16)]);
  console.log(`\nblock ${bn} ts ${parseInt(b.timestamp)} (0x${parseInt(b.timestamp).toString(16)})`);
  for (const x of b.transactions.filter(x => x.from.toLowerCase() === b.miner.toLowerCase())) {
    const moves = tr.filter(c => c.transactionHash === x.hash && c.type==='call').map(c => `${c.action.callType} ${c.action.from.slice(0,10)}->${c.action.to} ${f(c.action.value)}`);
    console.log(`  idx ${parseInt(x.transactionIndex)} value ${f(x.value)} input ${x.input}\n    ${moves.join('\n    ')}`);
  }
}
