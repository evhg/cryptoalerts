const RPC='https://mainnet.gateway.tenderly.co'
const rpc0=async(method,params)=>{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const j=await r.json();if(j.error)throw new Error(JSON.stringify(j.error));return j.result}
const rpc=async(m,p)=>{for(let i=0;;i++){try{return await rpc0(m,p)}catch(e){if(i>8)throw e;await new Promise(r=>setTimeout(r,700*(i+1)))}}}
const ST='0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9'
const head=parseInt(await rpc('eth_blockNumber',[]),16)
// blocks: ~27 Oct, ~9 Nov (before the run), ~14 Nov (pinned at 100%), ~23 Nov (before the 3M repayment), now
const pts=[['27 Oct',head-7200*30],['9 Nov',26380000-3000],['14 Nov',26412000],['22 Nov',26470000],['now',head]]
const bal=async(a,b)=>Number(BigInt(await rpc('eth_call',[{to:ST,data:'0x70a08231'+a.slice(2).toLowerCase().padStart(64,'0')},'0x'+b.toString(16)])))/1e24
console.log('shares in millions'.padEnd(44),pts.map(p=>p[0].padStart(8)).join(''))
const tot=[];for(const [n,b] of pts) tot.push(Number(BigInt(await rpc('eth_call',[{to:ST,data:'0x18160ddd'},'0x'+b.toString(16)])))/1e24)
console.log('TOTAL SUPPLY'.padEnd(44),tot.map(x=>x.toFixed(2).padStart(8)).join(''))
for(const a of process.argv.slice(2)){const r=[];for(const [n,b] of pts) r.push(await bal(a,b));console.log(a.padEnd(44),r.map(x=>x.toFixed(2).padStart(8)).join(''))}
